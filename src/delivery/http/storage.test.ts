import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { loadStorageConfig } from "../../app/storage-config.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "unused",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function withConfigDir(
  run: (dir: string, configPath: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "thebe-http-storage-"));
  const previous = process.env.THEBE_CONFIG_DIR;
  process.env.THEBE_CONFIG_DIR = dir;
  try {
    await run(dir, join(dir, "config.json"));
  } finally {
    if (previous === undefined) delete process.env.THEBE_CONFIG_DIR;
    else process.env.THEBE_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function request(
  app: ReturnType<typeof createThebeApp>,
  path: string,
  init?: RequestInit
): Promise<Response> {
  return app.handler.handle(new Request(`http://127.0.0.1:8787${path}`, init));
}

describe("Storage product HTTP", () => {
  it("reads and replaces storage backends with redacted secrets", async () => {
    await withConfigDir(async (dir) => {
      const app = createThebeApp({
        runtime: createFakeRuntime().runtime,
        provider: provider(),
      });
      const initial = await json(await request(app, "/v1/settings/storage"));
      expect(initial).toMatchObject({ source: "none", backends: [] });

      const saved = await request(app, "/v1/settings/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default: "nas",
          backends: [
            { id: "media", type: "local", roots: [dir] },
            {
              id: "nas",
              type: "webdav",
              url: "https://nas.local/dav",
              username: "thebe",
              password: "webdav-pass",
              token: "{{SECRET_5p3kfq2o}}",
            },
          ],
        }),
      });
      expect(saved.status).toBe(200);
      const view = (await json(saved)) as {
        source: string;
        default: string;
        backends: Array<Record<string, unknown>>;
      };
      expect(view.source).toBe("config");
      expect(view.default).toBe("nas");
      expect(view.backends[0]).toEqual({
        id: "media",
        type: "local",
        roots: [dir],
        hasToken: false,
        hasPassword: false,
      });
      expect(view.backends[1]).not.toHaveProperty("password");
      expect(view.backends[1]).not.toHaveProperty("token");
      expect(view.backends[1]).toMatchObject({
        hasPassword: true,
        hasToken: true,
      });

      const updated = await request(app, "/v1/settings/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          backends: [
            { id: "media", type: "local", roots: [dir] },
            { id: "nas", type: "webdav", url: "https://nas.example/dav" },
          ],
        }),
      });
      expect(updated.status).toBe(200);
      const loaded = loadStorageConfig({ env: {} });
      expect(loaded.backends[1]).toMatchObject({
        id: "nas",
        url: "https://nas.example/dav",
        username: "thebe",
        password: "webdav-pass",
        token: "{{SECRET_5p3kfq2o}}",
      });
      // Omitting `default` keeps the current one when that backend still exists.
      expect(loaded.defaultId).toBe("nas");
    });
  });

  it("rejects malformed writes and tests configured backends", async () => {
    await withConfigDir(async (dir) => {
      const app = createThebeApp({
        runtime: createFakeRuntime().runtime,
        provider: provider(),
      });
      const invalid = await request(app, "/v1/settings/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default: "nope",
          backends: [{ id: "media", type: "local", roots: [dir] }],
        }),
      });
      expect(invalid.status).toBe(400);
      await request(app, "/v1/settings/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          backends: [
            { id: "media", type: "local", roots: [dir] },
            { id: "media", type: "local", roots: [dir] },
          ],
        }),
      }).then(async (response) => {
        expect(response.status).toBe(400);
        expect(JSON.stringify(await json(response))).toContain("duplicated");
      });

      const saved = await request(app, "/v1/settings/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          default: "media",
          backends: [{ id: "media", type: "local", roots: [dir] }],
        }),
      });
      expect(saved.status).toBe(200);

      const tested = await json(
        await request(app, "/v1/settings/storage/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      );
      expect(tested).toMatchObject({
        ok: true,
        results: [{ id: "media", type: "local", ok: true, total: 1 }],
      });

      expect(
        (
          await request(app, "/v1/settings/storage/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "nope" }),
          })
        ).status
      ).toBe(404);
      expect((await request(app, "/v1/settings/storage/test")).status).toBe(
        405
      );
    });
  });
});
