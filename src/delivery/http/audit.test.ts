import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createAuditLog, hashParameters } from "../../agent/security/audit/audit-log.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => { throw new Error("unused"); },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /v1/audit", () => {
  it("assigns a deterministic compatibility id to legacy rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const legacy = {
      timestamp: "2026-09-21T00:00:00.000Z",
      method: "container.logs",
      parameterHash: hashParameters({ id: "legacy" }),
      responseBytes: 20,
      budgetConsumed: 0,
      redactionFired: false,
    };
    await writeFile(auditPath, `${JSON.stringify(legacy)}\n`, "utf8");
    const audit = createAuditLog(auditPath, () => new Date("2026-09-21T00:00:00Z"));

    const page = await audit.list();
    const entry = page.entries[0];
    expect(entry?.id).toMatch(/^legacy-[a-f0-9]{64}$/);
    await expect(audit.get(entry?.id ?? "")).resolves.toEqual(entry);
  });

  it("returns newest redacted records with filters and an opaque cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    let timestamp = 0;
    const audit = createAuditLog(
      auditPath,
      () => new Date(Date.UTC(2026, 8, 21, 0, 0, timestamp++)),
    );
    await audit.append({
      method: "container.inspect",
      parameterHash: hashParameters({ id: "one", secret: "never persisted" }),
      responseBytes: 12,
      budgetConsumed: 0,
      redactionFired: false,
      sessionId: "session-a",
      result: "ok",
    });
    await audit.append({
      method: "container.logs",
      parameterHash: hashParameters({ id: "two" }),
      responseBytes: 20,
      budgetConsumed: 0,
      redactionFired: true,
      sessionId: "session-a",
      result: "error",
    });
    await audit.append({
      method: "container.inspect",
      parameterHash: hashParameters({ id: "three" }),
      responseBytes: 24,
      budgetConsumed: 0,
      redactionFired: false,
      sessionId: "session-b",
      result: "denied",
    });

    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      auditPath,
    });
    const first = await body(await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/audit?limit=2"),
    ));
    const entries = first.entries as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry.method)).toEqual([
      "container.inspect",
      "container.logs",
    ]);
    expect(entries[1]?.id).toEqual(expect.any(String));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain("never persisted");

    const detail = await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/audit/${entries[1]?.id}`),
    );
    expect(detail.status).toBe(200);
    expect(await body(detail)).toMatchObject({
      id: entries[1]?.id,
      method: "container.logs",
      sessionId: "session-a",
    });

    const missing = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/audit/missing"),
    );
    expect(missing.status).toBe(404);

    const older = await body(await app.handler.handle(
      new Request(`http://127.0.0.1:8787/v1/audit?cursor=${first.nextCursor}`),
    ));
    expect((older.entries as Array<Record<string, unknown>>).map((entry) => entry.method))
      .toEqual(["container.inspect"]);

    const filtered = await body(await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/audit?sessionId=session-a&result=error"),
    ));
    expect(filtered.entries).toEqual([
      expect.objectContaining({ method: "container.logs", sessionId: "session-a", result: "error" }),
    ]);
  });

  it("validates pagination and result filters", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    for (const query of ["limit=0", "cursor=-1", "result=unknown"]) {
      const response = await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/audit?${query}`),
      );
      expect(response.status).toBe(400);
    }
    const empty = await body(await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/audit"),
    ));
    expect(empty).toEqual({ entries: [] });
  });

  it("documents the product route and named schemas", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = await body(response);
    expect(document.paths).toHaveProperty("/v1/audit");
    expect(document.paths).toHaveProperty("/v1/audit/{id}");
    expect(document.components).toEqual(expect.objectContaining({
      schemas: expect.objectContaining({ AuditRecord: expect.any(Object), AuditList: expect.any(Object) }),
    }));
  });
});
