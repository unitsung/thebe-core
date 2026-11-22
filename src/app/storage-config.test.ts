import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  importStorageFromEnv,
  loadStorageConfig,
  removeStorageBackend,
  saveStorageConfig,
  setDefaultStorageBackend,
  storageConfigView,
  StorageRegistry,
  upsertStorageBackend,
  type StorageBackendConfig,
} from "./storage-config.ts";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "thebe-storage-config-"));
}

const local: StorageBackendConfig = {
  id: "media",
  type: "local",
  roots: ["/mnt/media"],
};

const openlist: StorageBackendConfig = {
  id: "openlist",
  type: "openlist",
  baseUrl: "http://192.168.5.6:5244",
  token: "secret-token",
};

describe("storage config", () => {
  it("writes the storage section without disturbing other config keys", async () => {
    const dir = await workspace();
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({ permissionMode: "plan", autoCompact: false })
      );
      const view = saveStorageConfig([local, openlist], {
        defaultId: "openlist",
        path,
      });
      expect(view.default).toBe("openlist");
      expect(view.backends.map((backend) => backend.id)).toEqual([
        "media",
        "openlist",
      ]);
      const document = JSON.parse(await readFile(path, "utf8"));
      expect(document.permissionMode).toBe("plan");
      expect(document.autoCompact).toBe(false);
      expect(document.storage.default).toBe("openlist");
      expect(document.storage.backends).toHaveLength(2);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports config problems without crashing and keeps healthy backends", async () => {
    const dir = await workspace();
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({
          storage: {
            default: "gone",
            backends: [
              { id: "media", type: "local", roots: ["/mnt/media"] },
              { id: "bad", type: "openlist", baseUrl: "not-a-url" },
              { id: "media", type: "local", roots: ["/mnt/other"] },
            ],
          },
        })
      );
      const loaded = loadStorageConfig({ path, env: {} });
      expect(loaded.source).toBe("config");
      expect(loaded.backends.map((backend) => backend.id)).toEqual(["media"]);
      expect(loaded.defaultId).toBe("media");
      const issues = loaded.issues.map((issue) => issue.message).join("\n");
      expect(issues).toContain("baseUrl must be an http(s) URL");
      expect(issues).toContain("id is duplicated");
      expect(issues).toContain("unknown backend: gone");
      const snapshot = new StorageRegistry({ path, env: {} }).snapshot();
      expect(snapshot.providers.map((provider) => provider.service)).toEqual([
        "media",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses environment variables only until config.json has a storage section", async () => {
    const dir = await workspace();
    try {
      const path = join(dir, "config.json");
      const env = {
        THEBE_OPENLIST_BASE_URL: "http://openlist.local:5244",
        THEBE_OPENLIST_TOKEN: "env-token",
        THEBE_FILES_LOCAL_ROOTS: "/mnt/a,/mnt/b",
      };
      const fromEnv = loadStorageConfig({ path, env });
      expect(fromEnv.source).toBe("env");
      expect(fromEnv.defaultId).toBe("openlist");
      expect(fromEnv.backends.map((backend) => backend.id)).toEqual([
        "openlist",
        "local",
      ]);
      saveStorageConfig([local], { defaultId: "media", path });
      const fromConfig = loadStorageConfig({ path, env });
      expect(fromConfig.source).toBe("config");
      expect(fromConfig.backends.map((backend) => backend.id)).toEqual([
        "media",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps stored secrets when an update omits them", async () => {
    const dir = await workspace();
    try {
      const path = join(dir, "config.json");
      saveStorageConfig(
        [
          openlist,
          {
            id: "nas",
            type: "webdav",
            url: "https://nas.local/dav",
            username: "thebe",
            password: "webdav-pass",
          },
        ],
        { path }
      );
      upsertStorageBackend(
        {
          id: "openlist",
          type: "openlist",
          baseUrl: "https://openlist.example",
        },
        { path }
      );
      upsertStorageBackend(
        { id: "nas", type: "webdav", url: "https://nas.example/dav" },
        { path }
      );
      const loaded = loadStorageConfig({ path, env: {} });
      expect(loaded.backends[0]).toEqual({
        id: "openlist",
        type: "openlist",
        baseUrl: "https://openlist.example",
        token: "secret-token",
      });
      expect(loaded.backends[1]).toEqual({
        id: "nas",
        type: "webdav",
        url: "https://nas.example/dav",
        username: "thebe",
        password: "webdav-pass",
      });
      const view = storageConfigView({ path, env: {} });
      expect(view.backends[0]).not.toHaveProperty("token");
      expect(view.backends[0]!.hasToken).toBe(true);
      expect(view.backends[1]!.hasPassword).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reloads the live registry without a restart", async () => {
    const dir = await workspace();
    try {
      const path = join(dir, "config.json");
      const registry = new StorageRegistry({ path, env: {} });
      expect(registry.snapshot()).toMatchObject({
        source: "none",
        providers: [],
      });

      saveStorageConfig([local], { defaultId: "media", path });
      expect(
        registry.snapshot().providers.map((provider) => provider.service)
      ).toEqual(["media"]);

      saveStorageConfig([local, openlist], {
        defaultId: "openlist",
        path,
      });
      const both = registry.snapshot();
      expect(both.providers.map((provider) => provider.service)).toEqual([
        "media",
        "openlist",
      ]);
      expect(both.defaultProvider?.service).toBe("openlist");

      removeStorageBackend("openlist", { path });
      const one = registry.snapshot();
      expect(one.providers.map((provider) => provider.service)).toEqual([
        "media",
      ]);
      expect(one.defaultProvider?.service).toBe("media");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sets defaults, rejects unknown ids, and imports environment variables", async () => {
    const dir = await workspace();
    try {
      const path = join(dir, "config.json");
      saveStorageConfig([local, openlist], { defaultId: "media", path });
      expect(setDefaultStorageBackend("openlist", { path }).default).toBe(
        "openlist"
      );
      expect(() => setDefaultStorageBackend("nope", { path })).toThrow(
        "unknown storage backend"
      );
      expect(() => removeStorageBackend("nope", { path })).toThrow(
        "unknown storage backend"
      );
      expect(() =>
        saveStorageConfig([{ id: "rel", type: "local", roots: ["media"] }], {
          path,
        })
      ).toThrow("absolute paths");
      expect(() => saveStorageConfig([local, local], { path })).toThrow(
        "duplicated"
      );

      const envPath = join(dir, "env-config.json");
      const view = importStorageFromEnv({
        path: envPath,
        env: {
          THEBE_OPENLIST_BASE_URL: "http://openlist.local:5244",
          THEBE_OPENLIST_TOKEN: "env-token",
        },
      });
      expect(view.source).toBe("config");
      expect(view.backends).toEqual([
        expect.objectContaining({ id: "openlist", type: "openlist" }),
      ]);
      expect(() =>
        importStorageFromEnv({ path: join(dir, "empty.json"), env: {} })
      ).toThrow("No storage environment variables");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
