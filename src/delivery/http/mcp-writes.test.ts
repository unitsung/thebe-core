import { describe, expect, it } from "vitest";
import type {
  ContainerDetail,
  ContainerInfoProvider,
} from "../../agent/capabilities/containers.ts";
import type { ServiceAPIProvider } from "../../agent/capabilities/service-api.ts";
import type { NavidromeProvider } from "../../agent/capabilities/navidrome.ts";
import type { McpRegistry } from "../../agent/extensions/mcp.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThebeHttpHandler } from "./handler.ts";
import {
  createDeviceToken,
  createTokenVerifier,
  type TokenVerifier,
} from "./token-store.ts";

function containers(): ContainerInfoProvider & { restarts: string[] } {
  let state = "exited";
  const box = {
    restarts: [] as string[],
    listContainers: async () => [],
    inspectContainer: async (): Promise<ContainerDetail> => ({
      id: "ctr-1",
      name: "emby",
      image: "emby/embyserver:4.8",
      state,
      config: { labels: {} },
      networkSettings: { ports: {} },
    }),
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 1,
      lastUpdated: 1,
    }),
    restartContainer: async (id: string) => {
      box.restarts.push(id);
      state = "running";
    },
  };
  return box;
}

function providerRegistry(calls: string[]): McpRegistry {
  const tool = (name: string, permission: "read" | "admin") => ({
    id: `mcp:radarr/${name}`,
    name: `mcp:radarr/${name}`,
    description: name,
    inputSchema: { type: "object" },
    category: "media" as const,
    permission,
    ...(permission === "admin" && {
      annotations: { destructiveHint: true },
    }),
    source: "external" as const,
    serverName: "radarr",
  });
  return {
    async listTools() {
      return [tool("list_movies", "read"), tool("delete_movie", "admin")];
    },
    async listServers() {
      return [];
    },
    async setServerEnabled(name, enabled) {
      return { name, status: enabled ? "configured" : "disabled" };
    },
    async invokeTool(name) {
      calls.push(name);
      return "done";
    },
    close() {},
  };
}

function petstore(requests: string[]): ServiceAPIProvider {
  return {
    id: "petstore",
    catalog: () => ({ operations: [] }),
    request: async (input) => {
      requests.push(`${input.method} ${input.path}`);
      return { ok: true, status: 200, body: {} };
    },
    operations: async () => [
      {
        id: "deletePet",
        method: "DELETE",
        path: "/pet/{petId}",
        readOnly: false,
        writable: true,
        parameters: [{ name: "petId", in: "path", required: true }],
      },
    ],
  };
}

function navidrome(created: string[]): NavidromeProvider {
  return {
    service: "navidrome",
    async listLibrary() {
      return { mode: "recent", albums: [] };
    },
    async search() {
      return { artists: [], albums: [], songs: [] };
    },
    async getArtist() {
      return undefined;
    },
    async getLyrics() {
      return undefined;
    },
    async getPlaybackQueue() {
      return { items: [], startIndex: 0, mode: "direct" };
    },
    async createPlaylist(input) {
      created.push(input.name);
      return undefined;
    },
    async updatePlaylist() {},
    async deletePlaylist() {},
  };
}

function setup(
  mcpWritesAllowed: boolean,
  requests: string[] = [],
  playlists: string[] = [],
  token?: TokenVerifier,
  auditPath?: string
) {
  const calls: string[] = [];
  const provider = containers();
  const repairs: unknown[] = [];
  const agent = createThebeAgent({
    runtime: createFakeRuntime().runtime,
    provider,
    mcp: providerRegistry(calls),
    serviceAPIProviders: [petstore(requests)],
    navidrome: navidrome(playlists),
    strmRepairProvider: {
      service: "openlist",
      async repair(input) {
        repairs.push(input);
        return { status: "repaired", summary: "repaired" };
      },
    },
    mcpWritesAllowed,
    auditPath,
  });
  const handler = createThebeHttpHandler({ version: "0.1.0", agent, token });
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    bearer?: string
  ) => {
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer && { Authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    );
    return (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
      error?: unknown;
    };
  };
  return { call, calls, provider, repairs, agent, handler };
}

const text = (reply: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) =>
  reply.result?.content?.[0]?.text ?? "";

describe("/mcp write tools", () => {
  it("are refused when the host turns writes off, whoever lists them", async () => {
    const { call, calls, provider, repairs } = setup(false);
    for (const [name, args] of [
      ["container.restart", { id: "ctr-1" }],
      ["mcp:radarr/delete_movie", { id: 1 }],
      ["strm.repair", { title: "Dune" }],
    ] as const) {
      const reply = await call(name, args);
      expect(reply.result?.isError, name).toBe(true);
      expect(text(reply), name).toContain("THEBE_MCP_WRITES");
    }
    expect(calls).toEqual([]);
    expect(provider.restarts).toEqual([]);
    expect(repairs).toEqual([]);
  });

  it("cannot be previewed and confirmed by the calling agent when writes are off", async () => {
    const requests: string[] = [];
    const { call } = setup(false, requests);
    for (const [name, args] of [
      ["service_api.petstore.deletePet", { petId: 7 }],
      ["service_api.confirm", { token: "t" }],
    ] as const) {
      const reply = await call(name, args);
      expect(reply.result?.isError, name).toBe(true);
      expect(text(reply), name).toContain("THEBE_MCP_WRITES");
    }
    expect(requests).toEqual([]);
  });

  it("still run a provider tool that its server marks as a read", async () => {
    const { call, calls } = setup(false);
    const reply = await call("mcp:radarr/list_movies");
    expect(reply.result?.isError).toBeUndefined();
    expect(calls).toEqual(["mcp:radarr/list_movies"]);
  });

  it("run when the host enables them, and a restart leaves a receipt", async () => {
    const { call, calls, provider } = setup(true);
    const restart = await call("container.restart", { id: "ctr-1" });
    expect(restart.result?.isError).toBeUndefined();
    expect(provider.restarts).toEqual(["ctr-1"]);
    const receipt = JSON.parse(text(restart));
    expect(receipt.action.status).toBe("succeeded");
    expect(receipt.approval.source).toBe("mcp_client");

    const deleted = await call("mcp:radarr/delete_movie", { id: 1 });
    expect(deleted.result?.isError).toBeUndefined();
    expect(calls).toEqual(["mcp:radarr/delete_movie"]);
  });

  it("restart the same container again each time they are called", async () => {
    const { call, provider } = setup(true);
    await call("container.restart", { id: "ctr-1" });
    await call("container.restart", { id: "ctr-1" });
    expect(provider.restarts).toEqual(["ctr-1", "ctr-1"]);
  });

  it("let a Navidrome playlist be created unless the host turns writes off", async () => {
    const off = setup(false, [], []);
    const refused = await off.call("navidrome.playlist.create", {
      name: "Mix",
      songIds: ["s1"],
    });
    expect(refused.result?.isError).toBe(true);
    expect(text(refused)).toContain("THEBE_MCP_WRITES");

    const created: string[] = [];
    const on = setup(true, [], created);
    const done = await on.call("navidrome.playlist.create", {
      name: "Mix",
      songIds: ["s1"],
    });
    expect(done.result?.isError).toBeUndefined();
    expect(created).toEqual(["Mix"]);
  });

  it("need an id to restart a container", async () => {
    const { call, provider } = setup(true);
    const reply = await call("container.restart", {});
    expect(reply.result?.isError).toBe(true);
    expect(provider.restarts).toEqual([]);
  });
});

describe("/mcp write tools by token scope", () => {
  const read = "r".repeat(64);
  const write = "w".repeat(64);
  const full = "f".repeat(64);
  const irreversible = "i".repeat(64);

  async function withTokens(hostAllowsWrites: boolean) {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-scope-"));
    createDeviceToken({
      configDir,
      name: "Reader",
      scope: "mcp:read",
      generate: () => read,
    });
    createDeviceToken({
      configDir,
      name: "Writer",
      scope: "mcp:write",
      generate: () => write,
    });
    createDeviceToken({
      configDir,
      name: "Cleaner",
      scope: "mcp:irreversible",
      generate: () => irreversible,
    });
    createDeviceToken({ configDir, name: "iPad", generate: () => full });
    const requests: string[] = [];
    const playlists: string[] = [];
    const box = setup(
      hostAllowsWrites,
      requests,
      playlists,
      createTokenVerifier({ configDir, env: {} })
    );
    return { ...box, requests, playlists };
  }

  it("a read token reads, and every kind of write is refused with the scope to ask for", async () => {
    const { call, calls, provider, requests, playlists, repairs } =
      await withTokens(true);
    for (const [name, args] of [
      ["container.restart", { id: "ctr-1" }],
      ["mcp:radarr/delete_movie", { id: 1 }],
      ["service_api.petstore.deletePet", { petId: 7 }],
      ["service_api.confirm", { token: "t" }],
      ["navidrome.playlist.create", { name: "Mix", songIds: ["s1"] }],
      ["strm.repair", { title: "Dune" }],
    ] as const) {
      const reply = await call(name, args, read);
      expect(reply.result?.isError, name).toBe(true);
      expect(text(reply), name).toContain("mcp:write");
    }
    expect(calls).toEqual([]);
    expect(provider.restarts).toEqual([]);
    expect(requests).toEqual([]);
    expect(playlists).toEqual([]);
    expect(repairs).toEqual([]);

    const listed = await call("mcp:radarr/list_movies", {}, read);
    expect(listed.result?.isError).toBeUndefined();
    expect(calls).toEqual(["mcp:radarr/list_movies"]);
  });

  it("a write token, and a token with no scope, can write", async () => {
    const { call, provider, repairs } = await withTokens(true);
    for (const token of [write, full]) {
      const reply = await call("container.restart", { id: "ctr-1" }, token);
      expect(reply.result?.isError, token.slice(0, 1)).toBeUndefined();
      const repaired = await call("strm.repair", { title: "Dune" }, token);
      expect(repaired.result?.isError, token.slice(0, 1)).toBeUndefined();
    }
    expect(provider.restarts).toEqual(["ctr-1", "ctr-1"]);
    expect(repairs).toHaveLength(2);
  });

  it("a write token is still refused when the host turns writes off", async () => {
    const { call, provider } = await withTokens(false);
    const reply = await call("container.restart", { id: "ctr-1" }, write);
    expect(reply.result?.isError).toBe(true);
    expect(text(reply)).toContain("THEBE_MCP_WRITES");
    expect(provider.restarts).toEqual([]);
  });

  it("a write token is refused a delete that cannot be undone, at once, naming the scope", async () => {
    const { call, calls, requests, playlists } = await withTokens(true);
    for (const [name, args] of [
      ["mcp:radarr/delete_movie", { id: 1 }],
      ["service_api.petstore.deletePet", { petId: 7 }],
      ["navidrome.playlist.delete", { id: "p1" }],
    ] as const) {
      const reply = await call(name, args, write);
      expect(reply.result?.isError, name).toBe(true);
      expect(text(reply), name).toContain("mcp:irreversible");
    }
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
    expect(playlists).toEqual([]);
  });

  it("an irreversible token, and a token with no scope, can run them", async () => {
    const { call, calls } = await withTokens(true);
    for (const token of [irreversible, full]) {
      const reply = await call("mcp:radarr/delete_movie", { id: 1 }, token);
      expect(reply.result?.isError, token.slice(0, 1)).toBeUndefined();
    }
    expect(calls).toEqual([
      "mcp:radarr/delete_movie",
      "mcp:radarr/delete_movie",
    ]);
  });

  it("an irreversible token is still refused while the host has writes off", async () => {
    const { call, calls } = await withTokens(false);
    const reply = await call(
      "mcp:radarr/delete_movie",
      { id: 1 },
      irreversible
    );
    expect(reply.result?.isError).toBe(true);
    expect(text(reply)).toContain("THEBE_MCP_WRITES");
    expect(calls).toEqual([]);
  });
});

describe("/mcp audit rows", () => {
  it("name the token, mark a refusal as denied, and filter by caller", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-audit-"));
    const read = "r".repeat(64);
    const write = "w".repeat(64);
    createDeviceToken({
      configDir,
      name: "Reader",
      scope: "mcp:read",
      generate: () => read,
    });
    createDeviceToken({
      configDir,
      name: "Writer",
      scope: "mcp:write",
      generate: () => write,
    });
    const auditPath = join(configDir, "audit.jsonl");
    const { call, agent } = setup(
      true,
      [],
      [],
      createTokenVerifier({ configDir, env: {} }),
      auditPath
    );

    await call("mcp:radarr/list_movies", {}, read);
    await call("container.restart", { id: "ctr-1" }, read); // refused: read token
    await call("mcp:radarr/delete_movie", { id: 1 }, write); // refused: needs mcp:irreversible

    const rows = (await agent.listAudit({ identity: "Reader" })).entries;
    expect(rows.map((r) => [r.method, r.result, r.source]).sort()).toEqual([
      ["container.restart", "denied", "mcp"],
      ["mcp:radarr/list_movies", "ok", "mcp"],
    ]);
    const writer = (await agent.listAudit({ identity: "Writer" })).entries;
    expect(writer).toHaveLength(1);
    expect(writer[0]).toMatchObject({
      method: "mcp:radarr/delete_movie",
      result: "denied",
    });
    // The row keeps a hash of the arguments, never the arguments.
    expect(JSON.stringify(writer[0])).not.toContain('"id":1');
  });
});

describe("/mcp tools/list by token scope", () => {
  const read = "r".repeat(64);
  const write = "w".repeat(64);

  async function list(token: string) {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-list-"));
    createDeviceToken({
      configDir,
      name: "Reader",
      scope: "mcp:read",
      generate: () => read,
    });
    createDeviceToken({
      configDir,
      name: "Writer",
      scope: "mcp:write",
      generate: () => write,
    });
    const box = setup(
      true,
      [],
      [],
      createTokenVerifier({ configDir, env: {} })
    );
    const res = await box.handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    return body.result.tools.map((tool) => tool.name);
  }

  it("a read token is not shown the write tools, a write token is", async () => {
    const readerSees = await list(read);
    expect(readerSees).toContain("mcp:radarr/list_movies");
    for (const hidden of [
      "container.restart",
      "mcp:radarr/delete_movie",
      "navidrome.playlist.create",
    ]) {
      expect(readerSees, hidden).not.toContain(hidden);
    }
    const writerSees = await list(write);
    for (const shown of [
      "container.restart",
      "mcp:radarr/delete_movie",
      "navidrome.playlist.delete",
    ]) {
      expect(writerSees, shown).toContain(shown);
    }
  });
});

describe("/mcp service_api.confirm", () => {
  it("cannot run a DELETE the preview's caller was not allowed to send", async () => {
    const write = "w".repeat(64);
    const full = "f".repeat(64);
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-confirm-"));
    createDeviceToken({
      configDir,
      name: "Writer",
      scope: "mcp:write",
      generate: () => write,
    });
    createDeviceToken({ configDir, name: "iPad", generate: () => full });
    const requests: string[] = [];
    const { call } = setup(
      true,
      requests,
      [],
      createTokenVerifier({ configDir, env: {} })
    );
    // A full-access caller previews the DELETE; a write-only caller then tries to confirm it.
    const preview = await call(
      "service_api.petstore.deletePet",
      { petId: 7 },
      full
    );
    const confirmToken =
      JSON.parse(text(preview)).confirmToken ?? JSON.parse(text(preview)).token;
    expect(confirmToken, text(preview)).toBeTruthy();
    const refused = await call(
      "service_api.confirm",
      { token: confirmToken },
      write
    );
    expect(refused.result?.isError).toBe(true);
    expect(text(refused)).toContain("mcp:irreversible");
    expect(requests).toEqual([]);
    const allowed = await call(
      "service_api.confirm",
      { token: confirmToken },
      full
    );
    expect(allowed.result?.isError).toBeUndefined();
    expect(requests).toEqual(["DELETE /pet/7"]);
  });
});

describe("/mcp operator marks on provider tools", () => {
  function marked() {
    const calls: string[] = [];
    const tool = (name: string, extra: Record<string, unknown>) => ({
      id: `mcp:box/${name}`,
      name: `mcp:box/${name}`,
      description: name,
      inputSchema: { type: "object" },
      category: "other" as const,
      permission: "confirm" as const,
      source: "external" as const,
      serverName: "box",
      ...extra,
    });
    const registry: McpRegistry = {
      async listTools() {
        return [
          // The server calls it destructive; the operator says it can be undone.
          tool("wipe_cache", {
            annotations: { destructiveHint: true },
            irreversible: false,
          }),
          // The server says nothing; the operator says it cannot be undone.
          tool("purge_library", { irreversible: true }),
        ];
      },
      async listServers() {
        return [];
      },
      async setServerEnabled(name, enabled) {
        return { name, status: enabled ? "configured" : "disabled" };
      },
      async invokeTool(name) {
        calls.push(name);
        return "done";
      },
      close() {},
    };
    return { registry, calls };
  }

  it("beat the server's hint in both directions, for a token that may only write", async () => {
    const write = "w".repeat(64);
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-marks-"));
    createDeviceToken({
      configDir,
      name: "Writer",
      scope: "mcp:write",
      generate: () => write,
    });
    const { registry, calls } = marked();
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: containers(),
      mcp: registry,
      mcpWritesAllowed: true,
    });
    const handler = createThebeHttpHandler({
      version: "0.1.0",
      agent,
      token: createTokenVerifier({ configDir, env: {} }),
    });
    const run = async (name: string) => {
      const res = await handler.handle(
        new Request("http://127.0.0.1:8787/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${write}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
        })
      );
      return (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text: string }> };
      };
    };
    expect((await run("mcp:box/wipe_cache")).result?.isError).toBeUndefined();
    const refused = await run("mcp:box/purge_library");
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("mcp:irreversible");
    expect(calls).toEqual(["mcp:box/wipe_cache"]);
  });
});

describe("/mcp operator marks on service API operations", () => {
  it("replace the HTTP-method rule: a DELETE marked reversible runs, a POST marked irreversible is held", async () => {
    const write = "w".repeat(64);
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-opmarks-"));
    createDeviceToken({
      configDir,
      name: "Writer",
      scope: "mcp:write",
      generate: () => write,
    });
    const requests: string[] = [];
    const op = (id: string, method: string, irreversible: boolean) => ({
      id,
      method,
      path: `/${id}`,
      readOnly: false,
      writable: true,
      irreversible,
      parameters: [],
    });
    const provider: ServiceAPIProvider = {
      id: "shop",
      catalog: () => ({ operations: [] }),
      request: async (input) => {
        requests.push(`${input.method} ${input.path}`);
        return { ok: true, status: 200, body: {} };
      },
      operations: async () => [
        op("removeNote", "DELETE", false),
        op("emptyTrash", "POST", true),
      ],
    };
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: containers(),
      serviceAPIProviders: [provider],
      mcpWritesAllowed: true,
    });
    const handler = createThebeHttpHandler({
      version: "0.1.0",
      agent,
      token: createTokenVerifier({ configDir, env: {} }),
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await handler.handle(
        new Request("http://127.0.0.1:8787/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${write}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        })
      );
      return (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text: string }> };
      };
    };
    const reversible = await call("service_api.shop.removeNote");
    expect(reversible.result?.isError).toBeUndefined();
    const held = await call("service_api.shop.emptyTrash");
    expect(held.result?.isError).toBe(true);
    expect(held.result?.content?.[0]?.text).toContain("mcp:irreversible");
    // The held one never reached a preview, so there is nothing to confirm.
    expect(requests).toEqual([]);
  });
});
