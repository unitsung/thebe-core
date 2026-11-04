import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import type { NavidromeProvider } from "../../agent/capabilities/navidrome.ts";
import type { McpRegistry } from "../../agent/extensions/mcp.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { createDeviceToken, createTokenVerifier } from "./token-store.ts";

const tokens = {
  claude: "c".repeat(64),
  hermes: "h".repeat(64),
  full: "f".repeat(64),
};

const containers: ContainerInfoProvider = {
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

const navidrome: NavidromeProvider = {
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
  async deletePlaylist() {},
};

const registry: McpRegistry = {
  async listTools() {
    return [
      {
        id: "mcp:radarr/delete_movie",
        name: "mcp:radarr/delete_movie",
        description: "delete_movie",
        inputSchema: { type: "object" },
        category: "media" as const,
        permission: "admin" as const,
        source: "external" as const,
        serverName: "radarr",
      },
    ];
  },
  async listServers() {
    return [];
  },
  async setServerEnabled(name, enabled) {
    return { name, status: enabled ? "configured" : "disabled" };
  },
  async invokeTool(name) {
    return name.startsWith("mcp:radarr/") ? "done" : undefined;
  },
  close() {},
};

type AuditEntry = Record<string, unknown> & { method: string };

async function setup() {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-audit-caller-"));
  const auditPath = join(configDir, "audit.jsonl");
  createDeviceToken({
    configDir,
    name: "Claude",
    scope: "mcp:write",
    generate: () => tokens.claude,
  });
  createDeviceToken({
    configDir,
    name: "Hermes",
    scope: "mcp:write",
    generate: () => tokens.hermes,
  });
  createDeviceToken({ configDir, name: "iPad", generate: () => tokens.full });
  const agent = createThebeAgent({
    runtime: createFakeRuntime().runtime,
    provider: containers,
    mcp: registry,
    navidrome,
    auditPath,
    mcpWritesAllowed: true,
  });
  const handler = createThebeHttpHandler({
    version: "0.1.0",
    agent,
    token: createTokenVerifier({ configDir, env: {} }),
  });
  const call = (name: string, args: Record<string, unknown>, bearer: string) =>
    handler.handle(
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
  const audit = async (query = ""): Promise<AuditEntry[]> => {
    const res = await handler.handle(
      new Request(`http://127.0.0.1:8787/v1/audit${query}`, {
        headers: { Authorization: `Bearer ${tokens.full}` },
      })
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: AuditEntry[] }).entries;
  };
  return { call, audit, auditPath };
}

describe("audit caller over /mcp", () => {
  it("names the token on every record a call writes, whatever the tool", async () => {
    const { call, audit } = await setup();
    await call("container.list", {}, tokens.claude);
    await call("navidrome.playlist.create", { name: "Mix" }, tokens.hermes);
    await call("mcp:radarr/delete_movie", { id: 1 }, tokens.claude);

    const entries = await audit();
    const by = (method: string) => entries.filter((e) => e.method === method);
    expect(by("container.list").map((e) => e.caller)).toEqual(["Claude"]);
    expect(by("navidrome.playlist.create").map((e) => e.caller)).toEqual([
      "Hermes",
    ]);
    expect(by("mcp:radarr/delete_movie").map((e) => e.caller)).toEqual([
      "Claude",
    ]);
  });

  it("leaves records from the App's own calls without a caller", async () => {
    const { audit, auditPath } = await setup();
    const own = {
      timestamp: "2026-11-01T00:00:00.000Z",
      method: "container.list",
      parameterHash: "x".repeat(64),
      responseBytes: 2,
      budgetConsumed: 0,
      redactionFired: false,
      result: "ok",
    };
    await appendFile(auditPath, `${JSON.stringify(own)}\n`, "utf8");
    const entries = await audit();
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("caller");
  });

  it("filters the list by caller, combined with the other filters", async () => {
    const { call, audit, auditPath } = await setup();
    await call("container.list", {}, tokens.claude);
    await call("navidrome.playlist.create", { name: "Mix" }, tokens.hermes);
    await call("navidrome.playlist.create", { name: "Two" }, tokens.claude);
    await appendFile(
      auditPath,
      `${JSON.stringify({
        timestamp: "2026-11-01T00:00:00.000Z",
        method: "container.list",
        parameterHash: "x".repeat(64),
        responseBytes: 2,
        budgetConsumed: 0,
        redactionFired: false,
      })}\n`,
      "utf8"
    );

    expect(await audit()).toHaveLength(4);
    const claude = await audit("?caller=Claude");
    expect(claude.map((e) => e.method).sort()).toEqual([
      "container.list",
      "navidrome.playlist.create",
    ]);
    expect(claude.every((e) => e.caller === "Claude")).toBe(true);
    expect(
      (await audit("?caller=Claude&method=container.list")).map((e) => e.method)
    ).toEqual(["container.list"]);
    expect(await audit("?caller=Nobody")).toEqual([]);
    // An empty caller is no filter, like the other filters.
    expect(await audit("?caller=")).toHaveLength(4);
    expect(await readFile(auditPath, "utf8")).toContain('"caller":"Hermes"');
  });
});

describe("audit contract (contracts/audit.json)", () => {
  it("lists entries with and without a caller exactly as the App reads them", async () => {
    const contract = JSON.parse(
      await readFile(
        new URL("../../../contracts/audit.json", import.meta.url),
        "utf8"
      )
    ) as { entries: Array<Record<string, unknown>> };
    expect(contract.entries.some((e) => typeof e.caller === "string")).toBe(
      true
    );
    expect(contract.entries.some((e) => !("caller" in e))).toBe(true);

    const { audit, auditPath } = await setup();
    // The log is oldest first. A legacy row has no id; Core derives one from its line, which the contract carries.
    const rows = [...contract.entries].reverse().map((entry) => {
      if (typeof entry.id === "string" && entry.id.startsWith("legacy-")) {
        const { id: _id, ...row } = entry;
        return row;
      }
      return entry;
    });
    await appendFile(
      auditPath,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8"
    );

    const listed = await audit();
    expect(listed).toEqual(contract.entries);
    expect(listed.map((e) => e.caller)).toEqual([
      "Hermes",
      "Claude Desktop",
      undefined,
      undefined,
    ]);
  });
});
