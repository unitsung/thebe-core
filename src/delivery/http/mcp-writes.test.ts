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
  token?: TokenVerifier
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
  return { call, calls, provider, repairs };
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
      ["service_api.petstore.deletePet", { petId: 7 }],
      ["service_api.confirm", { token: "t" }],
      ["navidrome.playlist.create", { name: "Mix", songIds: ["s1"] }],
      ["strm.repair", { title: "Dune" }],
    ] as const) {
      const reply = await call(name, args, read);
      expect(reply.result?.isError, name).toBe(true);
      // A DELETE operation is an irreversible write, which asks for its own scope first.
      expect(text(reply), name).toContain(
        name === "service_api.petstore.deletePet"
          ? "mcp:irreversible"
          : "mcp:write"
      );
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
});
