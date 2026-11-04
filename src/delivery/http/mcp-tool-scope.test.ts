import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ContainerDetail,
  ContainerInfoProvider,
} from "../../agent/capabilities/containers.ts";
import type { NavidromeProvider } from "../../agent/capabilities/navidrome.ts";
import type { McpRegistry } from "../../agent/extensions/mcp.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { createDeviceToken, createTokenVerifier } from "./token-store.ts";

const read = "r".repeat(64);
const write = "w".repeat(64);
const full = "f".repeat(64);
const containersOnly = "c".repeat(64);
const mediaOnly = "m".repeat(64);

function containers(restarts: string[]): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async (): Promise<ContainerDetail> => ({
      id: "ctr-1",
      name: "emby",
      image: "emby/embyserver:4.8",
      state: "exited",
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
      restarts.push(id);
    },
  };
}

function radarr(calls: string[]): McpRegistry {
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

async function setup() {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-tools-"));
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
    name: "Containers",
    scope: "mcp:write",
    categories: ["containers"],
    generate: () => containersOnly,
  });
  createDeviceToken({
    configDir,
    name: "Media",
    scope: "mcp:write",
    categories: ["media"],
    generate: () => mediaOnly,
  });
  createDeviceToken({ configDir, name: "iPad", generate: () => full });
  const restarts: string[] = [];
  const providerCalls: string[] = [];
  const playlists: string[] = [];
  const agent = createThebeAgent({
    runtime: createFakeRuntime().runtime,
    provider: containers(restarts),
    mcp: radarr(providerCalls),
    navidrome: navidrome(playlists),
    mcpWritesAllowed: true,
  });
  const handler = createThebeHttpHandler({
    version: "0.1.0",
    agent,
    token: createTokenVerifier({ configDir, env: {} }),
  });
  const rpc = async (bearer: string, method: string, params?: unknown) => {
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const listed = async (bearer: string) =>
    (
      (await rpc(bearer, "tools/list")).body.result.tools as Array<{
        name: string;
      }>
    ).map((tool) => tool.name);
  const call = async (bearer: string, name: string, args = {}) =>
    (await rpc(bearer, "tools/call", { name, arguments: args })).body as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
  return { configDir, listed, call, rpc, restarts, providerCalls, playlists };
}

const WRITE_TOOLS = [
  "container.restart",
  "mcp:radarr/delete_movie",
  "navidrome.playlist.create",
];
const READ_TOOLS = ["container.logs", "mcp:radarr/list_movies"];

describe("tools/list by token scope", () => {
  it("a read token sees read tools only", async () => {
    const { listed } = await setup();
    const names = await listed(read);
    expect(names).toEqual(expect.arrayContaining(READ_TOOLS));
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
  });

  it("a write token sees read and write tools", async () => {
    const { listed } = await setup();
    const names = await listed(write);
    expect(names).toEqual(
      expect.arrayContaining([...READ_TOOLS, ...WRITE_TOOLS])
    );
  });

  it("a token with no scope still lists everything", async () => {
    const { listed } = await setup();
    const everything = await listed(full);
    expect(everything).toEqual(await listed(write));
    expect(everything.length).toBeGreaterThan(READ_TOOLS.length);
  });
});

describe("a write scope limited to service categories", () => {
  it("lists the read tools and only the write tools in its categories", async () => {
    const { listed } = await setup();
    const names = await listed(containersOnly);
    expect(names).toEqual(expect.arrayContaining(READ_TOOLS));
    expect(names).toContain("container.restart");
    expect(names).not.toContain("mcp:radarr/delete_movie");
    expect(names).not.toContain("navidrome.playlist.create");
    const media = await listed(mediaOnly);
    expect(media).toContain("mcp:radarr/delete_movie");
    expect(media).toContain("navidrome.playlist.create");
    expect(media).not.toContain("container.restart");
  });

  it("refuses a write outside its categories at once, naming the category", async () => {
    const { call, restarts, providerCalls, playlists } = await setup();
    const refused = await call(containersOnly, "mcp:radarr/delete_movie", {
      id: 1,
    });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("media");
    const playlist = await call(containersOnly, "navidrome.playlist.create", {
      name: "Mix",
      songIds: ["s1"],
    });
    expect(playlist.result?.isError).toBe(true);
    expect(playlist.result?.content?.[0]?.text).toContain("media");
    const restart = await call(mediaOnly, "container.restart", { id: "ctr-1" });
    expect(restart.result?.isError).toBe(true);
    expect(restart.result?.content?.[0]?.text).toContain("containers");
    expect(providerCalls).toEqual([]);
    expect(playlists).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("runs a write inside its categories and any read", async () => {
    const { call, restarts, providerCalls } = await setup();
    const done = await call(containersOnly, "container.restart", {
      id: "ctr-1",
    });
    expect(done.result?.isError).toBeUndefined();
    expect(restarts).toEqual(["ctr-1"]);
    const reading = await call(containersOnly, "mcp:radarr/list_movies");
    expect(reading.result?.isError).toBeUndefined();
    expect(providerCalls).toEqual(["mcp:radarr/list_movies"]);
  });

  it("a write token with no categories writes in every category", async () => {
    const { call, providerCalls, restarts } = await setup();
    await call(write, "mcp:radarr/delete_movie", { id: 1 });
    await call(write, "container.restart", { id: "ctr-1" });
    expect(providerCalls).toEqual(["mcp:radarr/delete_movie"]);
    expect(restarts).toEqual(["ctr-1"]);
  });

  it("refuses the token when the stored category list is one Core does not know", async () => {
    const { configDir, rpc } = await setup();
    const path = join(configDir, "tokens.json");
    const stored = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8")
    );
    for (const bad of [["containers", "spaceships"], [], "containers", [7]]) {
      stored.tokens.find(
        (t: { name: string }) => t.name === "Containers"
      ).categories = bad;
      await writeFile(path, JSON.stringify(stored));
      const res = await rpc(containersOnly, "tools/list");
      expect(res.status, JSON.stringify(bad)).toBe(401);
    }
  });
});
