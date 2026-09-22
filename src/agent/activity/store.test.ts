import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionReceipt } from "../action/types.ts";
import { CONTAINER_RESTART_ACTION_ID } from "../capabilities/containers.ts";
import { createActivityStore } from "./store.ts";

function receipt(overrides: Partial<ActionReceipt> = {}): ActionReceipt {
  return {
    receiptId: overrides.receiptId ?? "rcpt-1",
    actionId: CONTAINER_RESTART_ACTION_ID,
    resource: overrides.resource ?? {
      kind: "container",
      id: "ctr-emby",
      name: "emby",
      provider: "arcane",
    },
    approval: overrides.approval ?? {
      required: true,
      approved: true,
      source: "on_device",
      capability: {
        id: CONTAINER_RESTART_ACTION_ID,
        effect: "write",
        risk: "disruptive",
        approval: "required",
        permission: "confirm",
      },
    },
    action: overrides.action ?? {
      status: "succeeded",
      finishedAt: "2026-09-17T00:00:01Z",
      summary: "Restarted emby.",
    },
    verification: overrides.verification ?? {
      status: "passed",
      checks: [
        {
          id: "container.state",
          ok: true,
          expected: "running",
          actual: "running",
          source: "container.inspect",
          observedAt: "2026-09-17T00:00:01Z",
        },
      ],
    },
    idempotencyKey: overrides.idempotencyKey ?? "key-1",
    tokenUsed: false,
    ...overrides,
  };
}

describe("activity store", () => {
  it("round-trips a receipt to disk and reloads after a new store instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-"));
    const first = createActivityStore({
      dir,
      now: () => new Date("2026-09-17T00:00:00Z"),
    });
    const saved = await first.upsertFromReceipt(receipt());
    expect(saved.id).toBe("rcpt-1");
    expect(saved.status).toBe("succeeded");
    expect(saved.kind).toBe("container.restart");
    const onDisk = await readFile(join(dir, "rcpt-1.json"), "utf8");
    expect(onDisk).toContain("rcpt-1");

    const reloaded = createActivityStore({
      dir,
      now: () => new Date("2026-09-17T01:00:00Z"),
    });
    const listed = await reloaded.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.receiptId).toBe("rcpt-1");
    expect(listed[0]?.approval?.capability.approval).toBe("required");
    await expect(reloaded.get("rcpt-1")).resolves.toEqual(listed[0]);
  });

  it("skips corrupt files instead of failing the list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-"));
    const store = createActivityStore({ dir, now: () => new Date("2026-09-17T00:00:00Z") });
    await store.upsertFromReceipt(receipt());
    await writeFile(join(dir, "broken.json"), "{not-json", "utf8");
    await writeFile(
      join(dir, "empty.json"),
      JSON.stringify({ id: "nope" }),
      "utf8",
    );
    const second = createActivityStore({ dir, now: () => new Date() });
    const listed = await second.list();
    expect(listed.map((item) => item.id)).toEqual(["rcpt-1"]);
  });

  it("does not create a duplicate for the same idempotency key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-"));
    const store = createActivityStore({ dir, now: () => new Date("2026-09-17T00:00:00Z") });
    const first = await store.upsertFromReceipt(receipt({ receiptId: "rcpt-a" }));
    const second = await store.upsertFromReceipt(receipt({ receiptId: "rcpt-b" }));
    expect(second.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });

  it("retains only the newest records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-"));
    let tick = 0;
    const store = createActivityStore({
      dir,
      maxItems: 2,
      now: () => new Date(Date.UTC(2026, 8, 17, 0, 0, tick++)),
    });
    await store.upsertFromReceipt(receipt({ receiptId: "a", idempotencyKey: "a" }));
    await store.upsertFromReceipt(receipt({ receiptId: "b", idempotencyKey: "b" }));
    await store.upsertFromReceipt(receipt({ receiptId: "c", idempotencyKey: "c" }));
    const listed = await store.list();
    expect(listed.map((item) => item.id).sort()).toEqual(["b", "c"]);
  });

  it("maps verification_failed separately from action failure", async () => {
    const store = createActivityStore({ now: () => new Date("2026-09-17T00:00:00Z") });
    const record = await store.upsertFromReceipt(
      receipt({
        verification: {
          status: "failed",
          checks: [
            {
              id: "container.state",
              ok: false,
              expected: "running",
              actual: "exited",
              source: "container.inspect",
              observedAt: "2026-09-17T00:00:01Z",
            },
          ],
        },
      }),
    );
    expect(record.status).toBe("verification_failed");
  });

  it("mints one pending approval from a restart diagnosis and mutates it into the receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-activity-"));
    const store = createActivityStore({
      dir,
      now: () => new Date("2026-09-17T00:00:00Z"),
    });
    const pending = await store.upsertFromDiagnosis({
      runId: "run-diag",
      actionId: "container.diagnose",
      status: "completed",
      resource: {
        kind: "container",
        id: "ctr-emby",
        name: "emby",
        provider: "arcane",
      },
      observations: [],
      diagnosis: {
        code: "container_exited",
        title: "Container is not running",
        summary: "exited",
        confidence: "high",
        tokenUsed: false,
      },
      recommendations: [
        {
          id: "rec-restart",
          title: "Restart this container",
          detail: "needs approval",
          kind: "write",
          requiresApproval: true,
          actionId: "container.restart",
        },
      ],
      technicalDetails: { evidence: [], toolTranscript: [] },
    });
    expect(pending?.status).toBe("pending");
    expect(pending?.id).not.toBe("run-diag");
    expect(pending?.diagnosisRunId).toBe("run-diag");
    expect(await store.list("needs_approval")).toHaveLength(1);

    const mutated = await store.upsertFromReceipt(
      receipt({
        receiptId: "rcpt-after",
        diagnosisRunId: "run-diag",
        idempotencyKey: "after",
      }),
    );
    expect(mutated.id).toBe(pending?.id);
    expect(await store.list("needs_approval")).toEqual([]);
    expect((await store.list("recent")).map((item) => item.id)).toEqual([pending?.id]);
    expect(await store.list("running")).toEqual([]);
  });

  it("persists a diagnosis with no write recommendation", async () => {
    const store = createActivityStore({ now: () => new Date("2026-09-17T00:00:00Z") });
    const saved = await store.upsertFromDiagnosis({
      runId: "run-ok",
      actionId: "container.diagnose",
      status: "completed",
      resource: {
        kind: "container",
        id: "ctr-emby",
        name: "emby",
        provider: "arcane",
      },
      observations: [],
      diagnosis: {
        code: "container_running",
        title: "Container is running",
        summary: "running",
        confidence: "high",
        tokenUsed: false,
      },
      recommendations: [],
      technicalDetails: { evidence: [], toolTranscript: [] },
    });
    expect(saved).toEqual(
      expect.objectContaining({
        id: "run-ok",
        kind: "container.diagnose",
        status: "completed",
        group: "recent",
        summary: "Container is running",
        diagnosisRunId: "run-ok",
        recommendations: [],
      }),
    );
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: "run-ok", kind: "container.diagnose" }),
    ]);
  });

  it("removes a pending approval on deny", async () => {
    const store = createActivityStore({ now: () => new Date("2026-09-17T00:00:00Z") });
    const pending = await store.upsertFromDiagnosis({
      runId: "run-diag",
      actionId: "container.diagnose",
      status: "completed",
      resource: {
        kind: "container",
        id: "ctr-emby",
        name: "emby",
        provider: "arcane",
      },
      observations: [],
      diagnosis: {
        code: "container_exited",
        title: "Container is not running",
        summary: "exited",
        confidence: "high",
        tokenUsed: false,
      },
      recommendations: [
        {
          id: "rec-restart",
          title: "Restart this container",
          detail: "needs approval",
          kind: "write",
          requiresApproval: true,
          actionId: "container.restart",
        },
      ],
      technicalDetails: { evidence: [], toolTranscript: [] },
    });
    expect(await store.removePending(pending?.id ?? "")).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});
