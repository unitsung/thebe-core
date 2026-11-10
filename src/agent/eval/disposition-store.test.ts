import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEvalDispositionStore } from "./disposition-store.ts";

const DECISION_ID = "1".repeat(32);
const TRIGGER_ID = "2".repeat(32);

describe("Eval dispositions", () => {
  it("keeps dismissal idempotent and separate from the Decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-eval-dispositions-"));
    const store = createEvalDispositionStore({ dir });
    const first = await store.dismissDecision({
      decisionId: DECISION_ID,
      at: "2026-11-10T10:00:00.000Z",
      reason: "handled manually",
    });
    const again = await store.dismissDecision({
      decisionId: DECISION_ID,
      at: "2026-11-10T10:05:00.000Z",
      reason: "a later reason does not rewrite history",
    });

    expect(again).toEqual(first);
    const reopened = createEvalDispositionStore({ dir });
    await expect(reopened.getDecisionDismissal(DECISION_ID)).resolves.toEqual(
      first
    );
  });

  it("records each explicit requeue and survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-eval-requeues-"));
    const store = createEvalDispositionStore({ dir });
    const first = await store.requeueTrigger({
      triggerId: TRIGGER_ID,
      at: "2026-11-10T10:00:00.000Z",
      requester: "chat",
    });
    const second = await store.requeueTrigger({
      triggerId: TRIGGER_ID,
      at: "2026-11-10T10:00:00.000Z",
      requester: "chat",
    });

    expect(second.id).not.toBe(first.id);
    const reopened = createEvalDispositionStore({ dir });
    const rows = await reopened.listTriggerRequeues({
      triggerId: TRIGGER_ID,
    });
    expect(rows.map((row) => row.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });
});
