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
import { createThebeHttpHandler } from "./handler.ts";

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
  playlists: string[] = []
) {
  const calls: string[] = [];
  const provider = containers();
  const agent = createThebeAgent({
    runtime: createFakeRuntime().runtime,
    provider,
    mcp: providerRegistry(calls),
    serviceAPIProviders: [petstore(requests)],
    navidrome: navidrome(playlists),
    mcpWritesAllowed,
  });
  const handler = createThebeHttpHandler({ version: "0.1.0", agent });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
  return { call, calls, provider };
}

const text = (reply: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) =>
  reply.result?.content?.[0]?.text ?? "";

describe("/mcp write tools", () => {
  it("are refused by default, whoever lists them", async () => {
    const { call, calls, provider } = setup(false);
    for (const [name, args] of [
      ["container.restart", { id: "ctr-1" }],
      ["mcp:radarr/delete_movie", { id: 1 }],
    ] as const) {
      const reply = await call(name, args);
      expect(reply.result?.isError, name).toBe(true);
      expect(text(reply), name).toContain("THEBE_MCP_WRITES");
    }
    expect(calls).toEqual([]);
    expect(provider.restarts).toEqual([]);
  });

  it("cannot be previewed and confirmed by the calling agent either", async () => {
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

  it("let a Navidrome playlist be created only when the host enables writes", async () => {
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
