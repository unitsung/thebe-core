import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  let state = "exited";
  return {
    listContainers: async () => [],
    inspectContainer: async (id) => ({
      id,
      name: "emby",
      image: "emby/embyserver:4.8",
      state,
      config: {},
    }),
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: state === "running" ? 1 : 0,
      pausedContainers: 0,
      exitedContainers: state === "exited" ? 1 : 0,
      lastUpdated: 1,
    }),
    restartContainer: async () => {
      state = "running";
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Artifact product HTTP", () => {
  it("publishes an operation receipt artifact with metadata and content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-artifact-http-"));
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "container.restart",
          resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
          approval: { approved: true, client: "ios" },
          idempotencyKey: "artifact-action-1",
        }),
      }),
    );
    const receipt = await json(response);

    expect(receipt.artifactId).toEqual(expect.any(String));
    const artifactId = receipt.artifactId as string;
    const metadata = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}`),
      ),
    );
    expect(metadata).toEqual(expect.objectContaining({
      artifactId,
      kind: "operation_receipt",
      runId: receipt.receiptId,
      contentType: "application/json",
    }));

    const content = await json(
      await app.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}/content`),
      ),
    );
    expect(content.artifact).toEqual(expect.objectContaining({ artifactId }));
    expect(JSON.parse(content.content as string)).toEqual(
      expect.objectContaining({
        receiptId: receipt.receiptId,
        actionId: "container.restart",
      }),
    );
  });

  it("lists and reloads operation receipt artifacts after Core recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-artifact-restart-"));
    const first = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });
    const response = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionId: "container.restart",
          resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
          approval: { approved: true },
          idempotencyKey: "artifact-restart-1",
        }),
      }),
    );
    const receipt = await json(response);
    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: dir,
    });

    const listed = await json(
      await restarted.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/artifacts?kind=operation_receipt&runId=${receipt.receiptId}`,
        ),
      ),
    );
    expect(listed.artifacts).toEqual([
      expect.objectContaining({
        artifactId: receipt.artifactId,
        runId: receipt.receiptId,
      }),
    ]);

    const restoredReceipt = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/action/${receipt.receiptId}`),
      ),
    );
    expect(restoredReceipt.artifactId).toBe(receipt.artifactId);

    const content = await json(
      await restarted.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${receipt.artifactId}/content`),
      ),
    );
    expect(JSON.parse(content.content as string)).toEqual(
      expect.objectContaining({ receiptId: receipt.receiptId }),
    );
  });

  it("documents Artifact metadata and content routes", async () => {
    const { createThebeHttpHandler } = await import("./handler.ts");
    const document = await json(
      await createThebeHttpHandler({ version: "0.1.0" }).handle(
        new Request("http://127.0.0.1:8787/openapi.json"),
      ),
    );
    expect(document.paths).toEqual(expect.objectContaining({
      "/v1/artifacts": expect.objectContaining({ get: expect.any(Object) }),
      "/v1/artifacts/{id}": expect.objectContaining({ get: expect.any(Object) }),
      "/v1/artifacts/{id}/content": expect.objectContaining({ get: expect.any(Object) }),
    }));
    expect(document.components).toEqual(expect.objectContaining({
      schemas: expect.objectContaining({
        AgentArtifact: expect.any(Object),
        ArtifactList: expect.any(Object),
        ArtifactContent: expect.any(Object),
      }),
    }));
  });

  it("returns stable errors for missing Artifacts and invalid filters", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const missing = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/artifacts/missing"),
    );
    expect(missing.status).toBe(404);
    expect(await json(missing)).toEqual({ ok: false, error: "artifact not found" });

    const invalid = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/artifacts?kind=secret"),
    );
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toEqual({
      ok: false,
      error: "kind must be diagnosis, report, resource_list, operation_receipt",
      code: "invalid_body",
    });
  });
});
