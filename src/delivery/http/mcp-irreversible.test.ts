import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NavidromeProvider } from "../../agent/capabilities/navidrome.ts";
import type {
  DownloadItem,
  DownloadProvider,
} from "../../agent/capabilities/pipeline.ts";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { mcpIrreversibleAllowed } from "../../agent/security/irreversible.ts";
import { createDeviceToken, createTokenVerifier } from "./token-store.ts";

const HASH = "a".repeat(40);

const item: DownloadItem = {
  hash: HASH,
  id: HASH,
  name: "Dune.2021.1080p",
  engine: "qbittorrent",
  phase: "completed",
  badges: [],
  capabilities: ["remove", "remove_with_files"],
  state: "completed",
  progress: 1,
};

function downloads(removed: Array<{ hashes: string[]; deleteFiles: boolean }>) {
  const provider: DownloadProvider = {
    service: "qbittorrent",
    async add() {
      return { submitted: 1 };
    },
    async list() {
      return [item];
    },
    async get() {
      return item;
    },
    async remove(hashes, deleteFiles) {
      removed.push({ hashes, deleteFiles });
    },
  };
  return provider;
}

function navidrome(deleted: string[]): NavidromeProvider {
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
    async createPlaylist() {
      return undefined;
    },
    async updatePlaylist() {},
    async deletePlaylist(id) {
      deleted.push(id);
    },
  };
}

const noContainers: ContainerInfoProvider = {
  async listContainers() {
    return [];
  },
  async inspectContainer() {
    throw new Error("unused");
  },
  async getContainerLogs() {
    return "";
  },
  async getStatusSummary() {
    return {
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 0,
    };
  },
};

const tokens = {
  read: "r".repeat(64),
  write: "w".repeat(64),
  irreversible: "i".repeat(64),
  full: "f".repeat(64),
};

type Reply = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: unknown;
};
const text = (reply: Reply) => reply.result?.content?.[0]?.text ?? "";

async function setup(options: { irreversibleAllowed?: boolean } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-irreversible-"));
  createDeviceToken({
    configDir,
    name: "Reader",
    scope: "mcp:read",
    generate: () => tokens.read,
  });
  createDeviceToken({
    configDir,
    name: "Writer",
    scope: "mcp:write",
    generate: () => tokens.write,
  });
  createDeviceToken({
    configDir,
    name: "Janitor",
    scope: ["mcp:write", "mcp:irreversible"],
    generate: () => tokens.irreversible,
  });
  createDeviceToken({ configDir, name: "iPad", generate: () => tokens.full });
  const removed: Array<{ hashes: string[]; deleteFiles: boolean }> = [];
  const playlists: string[] = [];
  const agent = createThebeAgent({
    runtime: createFakeRuntime().runtime,
    provider: noContainers,
    pipeline: { downloads: downloads(removed) },
    navidrome: navidrome(playlists),
    auditPath: join(configDir, "audit.jsonl"),
    mcpWritesAllowed: true,
    ...(options.irreversibleAllowed !== undefined && {
      mcpIrreversibleAllowed: options.irreversibleAllowed,
    }),
  });
  const handler = createThebeHttpHandler({
    version: "0.1.0",
    agent,
    token: createTokenVerifier({ configDir, env: {} }),
  });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    bearer: string
  ): Promise<Reply> => {
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    );
    return (await res.json()) as Reply;
  };
  const audit = async () => {
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/v1/audit", {
        headers: { Authorization: `Bearer ${tokens.full}` },
      })
    );
    return ((await res.json()) as { entries: Array<Record<string, unknown>> })
      .entries;
  };
  return { call, audit, removed, playlists };
}

const deleteWithFiles = { hashes: [HASH], deleteFiles: true };
const deleteTaskOnly = { hashes: [HASH], deleteFiles: false };

describe("irreversible deletes over /mcp", () => {
  it("are refused at once for a read or write token, naming the scope to ask for", async () => {
    const { call, removed, playlists } = await setup();
    for (const token of [tokens.read, tokens.write]) {
      for (const [name, args] of [
        ["download.delete", deleteWithFiles],
        ["navidrome.playlist.delete", { playlistId: "p1" }],
      ] as const) {
        const reply = await call(name, args, token);
        expect(reply.result?.isError, `${name} ${token[0]}`).toBe(true);
        expect(text(reply), name).toContain("irreversible");
        if (token === tokens.write) {
          expect(text(reply), name).toContain("mcp:irreversible");
        }
      }
    }
    expect(removed).toEqual([]);
    expect(playlists).toEqual([]);
  });

  it("run for a token made with the irreversible scope, and the audit record and result say so", async () => {
    const { call, audit, removed, playlists } = await setup();
    const files = await call(
      "download.delete",
      deleteWithFiles,
      tokens.irreversible
    );
    expect(files.result?.isError).toBeUndefined();
    expect(text(files).toLowerCase()).toContain("irreversible");
    const playlist = await call(
      "navidrome.playlist.delete",
      { playlistId: "p1" },
      tokens.irreversible
    );
    expect(playlist.result?.isError).toBeUndefined();
    expect(text(playlist).toLowerCase()).toContain("irreversible");
    expect(removed).toEqual([{ hashes: [HASH], deleteFiles: true }]);
    expect(playlists).toEqual(["p1"]);

    const records = (await audit()).filter((entry) => entry.irreversible);
    expect(records.map((entry) => entry.method).sort()).toEqual([
      "download.delete",
      "navidrome.playlist.delete",
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        source: "mcp",
        caller: "Janitor",
        result: "ok",
      });
    }
  });

  it("run for a token with no scope list, which has full access", async () => {
    const { call, removed } = await setup();
    const reply = await call("download.delete", deleteWithFiles, tokens.full);
    expect(reply.result?.isError).toBeUndefined();
    expect(removed).toEqual([{ hashes: [HASH], deleteFiles: true }]);
  });

  it("are refused for every token, including one with the scope, when the host turns them off", async () => {
    const { call, removed, playlists } = await setup({
      irreversibleAllowed: false,
    });
    for (const token of [tokens.write, tokens.irreversible, tokens.full]) {
      for (const [name, args] of [
        ["download.delete", deleteWithFiles],
        ["navidrome.playlist.delete", { playlistId: "p1" }],
      ] as const) {
        const reply = await call(name, args, token);
        expect(reply.result?.isError, `${name} ${token[0]}`).toBe(true);
        expect(text(reply), name).toContain("THEBE_MCP_IRREVERSIBLE");
      }
    }
    expect(removed).toEqual([]);
    expect(playlists).toEqual([]);
  });

  it("leave deleting only the download task an ordinary write for a write token", async () => {
    const { call, audit, removed } = await setup();
    const reply = await call("download.delete", deleteTaskOnly, tokens.write);
    expect(reply.result?.isError).toBeUndefined();
    expect(text(reply).toLowerCase()).not.toContain("irreversible");
    expect(removed).toEqual([{ hashes: [HASH], deleteFiles: false }]);
    expect((await audit()).some((entry) => entry.irreversible)).toBe(false);
  });

  it("still keep a read token from deleting even only the download task", async () => {
    const { call, removed } = await setup();
    const reply = await call("download.delete", deleteTaskOnly, tokens.read);
    expect(reply.result?.isError).toBe(true);
    expect(text(reply)).toContain("mcp:write");
    expect(removed).toEqual([]);
  });

  it("do not count a call that does not ask for the files to go as irreversible", async () => {
    const { call, removed } = await setup();
    // The tool refuses an unstated deleteFiles itself; nothing is deleted and no scope is demanded.
    const reply = await call(
      "download.delete",
      { hashes: [HASH] },
      tokens.write
    );
    expect(reply.result?.isError).toBe(true);
    expect(text(reply)).toContain("deleteFiles");
    expect(removed).toEqual([]);
  });
});

describe("downloads over /mcp", () => {
  it("are listed for the agent, and a read token can list them but not change them", async () => {
    const { call } = await setup();
    const listed = await call("download.list", {}, tokens.read);
    expect(listed.result?.isError).toBeUndefined();
    expect(text(listed)).toContain("Dune.2021.1080p");
    const added = await call(
      "download.add",
      { magnet: "magnet:?xt=urn:btih:abc" },
      tokens.read
    );
    expect(added.result?.isError).toBe(true);
    expect(text(added)).toContain("mcp:write");
  });
});

describe("the host switch for irreversible deletes", () => {
  it("is on unless THEBE_MCP_IRREVERSIBLE says off", () => {
    expect(mcpIrreversibleAllowed({})).toBe(true);
    expect(mcpIrreversibleAllowed({ THEBE_MCP_IRREVERSIBLE: "on" })).toBe(true);
    for (const value of ["off", "OFF", "deny", "false", "0", "no"]) {
      expect(
        mcpIrreversibleAllowed({ THEBE_MCP_IRREVERSIBLE: value }),
        value
      ).toBe(false);
    }
  });
});
