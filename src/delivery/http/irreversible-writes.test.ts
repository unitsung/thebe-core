import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import type { ServiceAPIProvider } from "../../agent/capabilities/service-api.ts";
import type { McpRegistry, McpToolInfo } from "../../agent/extensions/mcp.ts";
import { withProductMetadata } from "../../agent/extensions/mcp.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { createDeviceToken, createTokenVerifier } from "./token-store.ts";

const tokens = {
  write: "w".repeat(64),
  irreversible: "i".repeat(64),
  full: "f".repeat(64),
};

type Reply = {
  result?: { isError?: boolean; content?: Array<{ text: string }> };
  error?: unknown;
};
const text = (reply: Reply) => reply.result?.content?.[0]?.text ?? "";

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

/** A Radarr-like service: a DELETE that takes a deleteFiles flag, and operators' overrides. */
function radarr(requests: string[]): ServiceAPIProvider {
  return {
    id: "radarr",
    catalog: () => ({ operations: [] }),
    request: async (input) => {
      requests.push(`${input.method} ${input.path}`);
      return { ok: true, status: 200, body: {} };
    },
    operations: async () => [
      {
        id: "deleteMovie",
        method: "DELETE",
        path: "/movie/{id}",
        readOnly: false,
        writable: true,
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "deleteFiles", in: "query", required: false },
        ],
      },
      {
        id: "updateMovie",
        method: "PUT",
        path: "/movie/{id}",
        readOnly: false,
        writable: true,
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "deleteFiles", in: "query", required: false },
          { name: "moveFiles", in: "query", required: false },
        ],
      },
      {
        // The operator checked that this DELETE only removes a tag.
        id: "deleteTag",
        method: "DELETE",
        path: "/tag/{id}",
        readOnly: false,
        writable: true,
        irreversibleOverride: false,
        parameters: [{ name: "id", in: "path", required: true }],
      },
      {
        // The operator knows this POST empties the recycle bin.
        id: "emptyRecycleBin",
        method: "POST",
        path: "/recyclebin/empty",
        readOnly: false,
        writable: true,
        irreversibleOverride: true,
        parameters: [],
      },
    ],
  };
}

function externalTool(
  name: string,
  extra: Partial<McpToolInfo> = {}
): McpToolInfo {
  return {
    id: `mcp:nas/${name}`,
    name: `mcp:nas/${name}`,
    description: name,
    inputSchema: { type: "object" },
    category: "files",
    permission: "confirm",
    source: "external",
    serverName: "nas",
    ...extra,
  };
}

function nasRegistry(calls: string[]): McpRegistry {
  return {
    async listTools() {
      return [
        externalTool("wipe_volume", { annotations: { destructiveHint: true } }),
        externalTool("rename", { annotations: { destructiveHint: false } }),
        externalTool("touch"),
        // The operator checked that this one is safe despite what the server says.
        externalTool("prune_cache", {
          annotations: { destructiveHint: true },
          irreversibleOverride: false,
        }),
        // The operator knows this one deletes although the server does not say so.
        externalTool("shred", { irreversibleOverride: true }),
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
}

async function setup() {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-irreversible-writes-"));
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
  const requests: string[] = [];
  const external: string[] = [];
  const agent = createThebeAgent({
    runtime: createFakeRuntime().runtime,
    provider: noContainers,
    serviceAPIProviders: [radarr(requests)],
    mcp: nasRegistry(external),
    auditPath: join(configDir, "audit.jsonl"),
    mcpWritesAllowed: true,
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
  /** Preview a per-operation write and, when it was accepted, confirm it. */
  const preview = async (
    name: string,
    args: Record<string, unknown>,
    bearer: string
  ) => {
    const reply = await call(name, args, bearer);
    if (reply.result?.isError) return { reply };
    const { confirmToken } = JSON.parse(text(reply)) as {
      confirmToken: string;
    };
    return {
      reply,
      confirmed: await call(
        "service_api.confirm",
        { token: confirmToken },
        bearer
      ),
    };
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
  return { call, preview, audit, requests, external };
}

describe("irreversible generic OpenAPI writes over /mcp", () => {
  it("refuse a DELETE operation for a write token, and run it for a token that may delete", async () => {
    const { preview, requests } = await setup();
    const refused = await preview(
      "service_api.radarr.deleteMovie",
      { id: 7 },
      tokens.write
    );
    expect(refused.reply.result?.isError).toBe(true);
    expect(text(refused.reply)).toContain("irreversible");
    expect(text(refused.reply)).toContain("mcp:irreversible");
    expect(requests).toEqual([]);

    const allowed = await preview(
      "service_api.radarr.deleteMovie",
      { id: 7 },
      tokens.irreversible
    );
    expect(allowed.reply.result?.isError).toBeUndefined();
    expect(allowed.confirmed?.result?.isError).toBeUndefined();
    expect(requests).toEqual(["DELETE /movie/7"]);
  });

  it("refuse a non-DELETE operation whose delete-like argument is true, and allow it when it is false", async () => {
    const { preview, requests } = await setup();
    for (const deleteFiles of [true, "true"]) {
      const refused = await preview(
        "service_api.radarr.updateMovie",
        { id: 7, deleteFiles },
        tokens.write
      );
      expect(refused.reply.result?.isError, String(deleteFiles)).toBe(true);
      expect(text(refused.reply)).toContain("deleteFiles");
    }
    expect(requests).toEqual([]);

    // Moving files is not deleting them, and a false flag asks for nothing destructive.
    for (const args of [
      { id: 7, deleteFiles: false },
      { id: 7, moveFiles: true },
    ]) {
      const done = await preview(
        "service_api.radarr.updateMovie",
        args,
        tokens.write
      );
      expect(
        done.confirmed?.result?.isError,
        JSON.stringify(args)
      ).toBeUndefined();
    }
    expect(requests).toHaveLength(2);
  });

  it("judge the generic service_api_write by method and by delete-like query or body", async () => {
    const { call, requests } = await setup();
    for (const args of [
      { service: "radarr", method: "DELETE", path: "/anything/1" },
      { service: "radarr", method: "POST", path: "/queue?removeData=true" },
      {
        service: "radarr",
        method: "POST",
        path: "/queue",
        body: { purge: true },
      },
    ]) {
      const refused = await call("service_api_write", args, tokens.write);
      expect(refused.result?.isError, JSON.stringify(args)).toBe(true);
      expect(text(refused), JSON.stringify(args)).toContain("mcp:irreversible");
    }
    expect(requests).toEqual([]);

    const ordinary = await call(
      "service_api_write",
      {
        service: "radarr",
        method: "POST",
        path: "/command",
        body: { name: "Refresh" },
      },
      tokens.write
    );
    expect(ordinary.result?.isError).toBeUndefined();
    expect(requests).toEqual(["POST /command"]);

    const allowed = await call(
      "service_api_write",
      { service: "radarr", method: "DELETE", path: "/movie/7" },
      tokens.irreversible
    );
    expect(allowed.result?.isError).toBeUndefined();
    expect(requests).toEqual(["POST /command", "DELETE /movie/7"]);
  });

  it("let the operator override one operation either way, and audit that the override decided", async () => {
    const { preview, call, audit, requests } = await setup();
    // A DELETE the operator marked ordinary runs for a plain write token.
    const tag = await preview(
      "service_api.radarr.deleteTag",
      { id: 3 },
      tokens.write
    );
    expect(tag.confirmed?.result?.isError).toBeUndefined();
    expect(requests).toEqual(["DELETE /tag/3"]);
    // A POST the operator marked irreversible is refused for it.
    const empty = await call(
      "service_api.radarr.emptyRecycleBin",
      {},
      tokens.write
    );
    expect(empty.result?.isError).toBe(true);
    expect(text(empty)).toContain("mcp:irreversible");
    expect(requests).toEqual(["DELETE /tag/3"]);
    // Another operation is still judged by the rules, so the override reaches one operation only.
    const movie = await call(
      "service_api.radarr.deleteMovie",
      { id: 7 },
      tokens.write
    );
    expect(movie.result?.isError).toBe(true);

    const overrides = (await audit()).filter(
      (entry) => entry.method === "service_api.irreversible_override"
    );
    expect(
      Object.fromEntries(
        overrides.map((entry) => [entry.identity, entry.override])
      )
    ).toEqual({
      "radarr.deleteTag": "ordinary",
      "radarr.emptyRecycleBin": "irreversible",
    });
    expect(overrides).toHaveLength(2);
    for (const record of overrides) {
      expect(record).toMatchObject({ caller: "Writer", source: "mcp" });
    }
  });
});

describe("irreversible external MCP tools over /mcp", () => {
  it("refuse a tool that declares itself destructive and run one that does not", async () => {
    const { call, external } = await setup();
    const refused = await call("mcp:nas/wipe_volume", {}, tokens.write);
    expect(refused.result?.isError).toBe(true);
    expect(text(refused)).toContain("mcp:irreversible");
    expect(external).toEqual([]);

    for (const name of ["rename", "touch"]) {
      const done = await call(`mcp:nas/${name}`, {}, tokens.write);
      expect(done.result?.isError, name).toBeUndefined();
    }
    expect(external).toEqual(["mcp:nas/rename", "mcp:nas/touch"]);

    const allowed = await call("mcp:nas/wipe_volume", {}, tokens.irreversible);
    expect(allowed.result?.isError).toBeUndefined();
    expect(external).toHaveLength(3);
  });

  it("let the operator override one tool either way, and audit it", async () => {
    const { call, audit, external } = await setup();
    const pruned = await call("mcp:nas/prune_cache", {}, tokens.write);
    expect(pruned.result?.isError).toBeUndefined();
    const shredded = await call("mcp:nas/shred", {}, tokens.write);
    expect(shredded.result?.isError).toBe(true);
    expect(external).toEqual(["mcp:nas/prune_cache"]);
    const overrides = (await audit()).filter(
      (entry) => entry.method === "mcp.irreversible_override"
    );
    expect(
      Object.fromEntries(
        overrides.map((entry) => [entry.identity, entry.override])
      )
    ).toEqual({
      "mcp:nas/prune_cache": "ordinary",
      "mcp:nas/shred": "irreversible",
    });
    expect(overrides).toHaveLength(2);
  });
});

describe("registering a provider write", () => {
  const writeTool = {
    id: "truenas.snapshot.delete",
    name: "truenas.snapshot.delete",
    description: "Delete a snapshot",
    inputSchema: { type: "object" },
    category: "storage" as const,
    permission: "confirm" as const,
    effect: "write" as const,
    source: "core" as const,
  };

  it("fails when it does not say whether the write is irreversible", () => {
    expect(() => withProductMetadata(writeTool)).toThrow(/irreversible/);
  });

  it("accepts a write that says so, and a read that says nothing", () => {
    expect(
      withProductMetadata({ ...writeTool, irreversible: true }).irreversible
    ).toBe(true);
    expect(
      withProductMetadata({ ...writeTool, irreversible: "by_call" })
        .irreversible
    ).toBe("by_call");
    expect(
      withProductMetadata({
        ...writeTool,
        permission: "read",
        effect: "read",
      }).irreversible
    ).toBeUndefined();
  });

  it("is not required of an external server's tool, which the rules judge", () => {
    expect(() =>
      withProductMetadata({ ...writeTool, source: "external" })
    ).not.toThrow();
  });
});
