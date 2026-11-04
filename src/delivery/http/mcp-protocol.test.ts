import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const MODERN = "2026-07-28";
const ALL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];

const containers: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "ok",
  getStatusSummary: async () => ({
    totalContainers: 4,
    runningContainers: 2,
    pausedContainers: 0,
    exitedContainers: 2,
    lastUpdated: 1,
  }),
};

function setup() {
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider: containers,
    version: "9.9.9",
  });
  return async (
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: any; headers: Headers }> => {
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    );
    const text = await res.text();
    return {
      status: res.status,
      body: text ? JSON.parse(text) : undefined,
      headers: res.headers,
    };
  };
}

/** A request in the newest style: version and capabilities in `_meta`, method and name mirrored in headers. */
function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1
): {
  body: {
    jsonrpc: string;
    id: number | string;
    method: string;
    params: { _meta: Record<string, unknown> } & Record<string, unknown>;
  };
  headers: Record<string, string>;
} {
  const name = typeof params.name === "string" ? params.name : undefined;
  return {
    body: {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": {
            name: "ExampleClient",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    } as Record<string, string>,
  };
}

describe("/mcp, newest protocol version (2026-07-28)", () => {
  it("answers tools/list without an initialize call, with cache hints and a stable order", async () => {
    const post = setup();
    const first = modernRequest("tools/list");
    const res = await post(first.body, first.headers);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.result.resultType).toBe("complete");
    expect(res.body.result.ttlMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(res.body.result.ttlMs)).toBe(true);
    expect(["public", "private"]).toContain(res.body.result.cacheScope);
    expect(res.body.result.nextCursor).toBeUndefined();
    expect(res.body.result._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": {
        name: "thebe-core",
        version: "9.9.9",
      },
    });

    const names = res.body.result.tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(names).toContain("container.status_summary");
    expect(names).toEqual([...names].sort());

    const again = await post(first.body, first.headers);
    expect(again.body.result.tools).toEqual(res.body.result.tools);
  });

  it("answers tools/call with a complete result", async () => {
    const post = setup();
    const call = modernRequest("tools/call", {
      name: "container.status_summary",
      arguments: {},
    });
    const res = await post(call.body, call.headers);
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe("complete");
    expect(res.body.result.isError).toBeUndefined();
    expect(res.body.result.content[0].text).toContain("totalContainers");
  });

  it("accepts a base64-encoded Mcp-Name that decodes to the tool name", async () => {
    const post = setup();
    const call = modernRequest("tools/call", {
      name: "container.status_summary",
      arguments: {},
    });
    const encoded = Buffer.from("container.status_summary").toString("base64");
    const res = await post(call.body, {
      ...call.headers,
      "mcp-name": `=?base64?${encoded}?=`,
    });
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe("complete");
  });

  it("returns a tool failure as a result and an unknown tool as a protocol error", async () => {
    const post = setup();
    const unknown = modernRequest("tools/call", { name: "no.such.tool" });
    const res = await post(unknown.body, unknown.headers);
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.id).toBe(1);
  });

  it("describes itself on server/discover, with cache hints", async () => {
    const post = setup();
    const discover = modernRequest("server/discover", {}, "discover-1");
    const res = await post(discover.body, discover.headers);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("discover-1");
    expect(res.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ALL_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "thebe-core",
          version: "9.9.9",
        },
      },
      cacheScope: "public",
    });
    expect(res.body.result.ttlMs).toBeGreaterThanOrEqual(0);
  });

  it("answers ping with a complete result", async () => {
    const post = setup();
    const ping = modernRequest("ping");
    const res = await post(ping.body, ping.headers);
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBe("complete");
  });

  it("rejects a method it does not implement with 404 and -32601", async () => {
    const post = setup();
    const list = modernRequest("resources/list");
    const res = await post(list.body, list.headers);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32601);
  });

  describe("rejects a request whose headers do not match its body with 400 and -32020", () => {
    const cases: Array<[string, (headers: Record<string, string>) => void]> = [
      [
        "no MCP-Protocol-Version header",
        (h) => delete h["mcp-protocol-version"],
      ],
      ["no Mcp-Method header", (h) => delete h["mcp-method"]],
      [
        "a different Mcp-Method header",
        (h) => (h["mcp-method"] = "tools/list"),
      ],
      ["no Mcp-Name header", (h) => delete h["mcp-name"]],
      [
        "a different Mcp-Name header",
        (h) => (h["mcp-name"] = "container.logs"),
      ],
      [
        "a Mcp-Name header that is not valid base64",
        (h) => (h["mcp-name"] = "=?base64?%%%?="),
      ],
    ];
    for (const [label, change] of cases) {
      it(label, async () => {
        const post = setup();
        const call = modernRequest("tools/call", {
          name: "container.status_summary",
          arguments: {},
        });
        change(call.headers);
        const res = await post(call.body, call.headers);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe(-32020);
        expect(res.body.id).toBe(1);
      });
    }

    it("a protocol version header that differs from _meta", async () => {
      const post = setup();
      const list = modernRequest("tools/list");
      const res = await post(list.body, {
        ...list.headers,
        "mcp-protocol-version": "2025-11-25",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32020);
    });
  });

  describe("rejects a request missing required _meta fields with 400 and -32602", () => {
    it("no client capabilities", async () => {
      const post = setup();
      const list = modernRequest("tools/list");
      delete list.body.params._meta[
        "io.modelcontextprotocol/clientCapabilities"
      ];
      const res = await post(list.body, list.headers);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32602);
    });

    it("no protocol version in _meta although the header names the newest version", async () => {
      const post = setup();
      const list = modernRequest("tools/list");
      delete list.body.params._meta["io.modelcontextprotocol/protocolVersion"];
      const res = await post(list.body, list.headers);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32602);
    });

    it("server/discover without any version information", async () => {
      const post = setup();
      const res = await post({
        jsonrpc: "2.0",
        id: 4,
        method: "server/discover",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32602);
    });
  });

  it("answers an unsupported version with 400, -32022 and the versions to retry with", async () => {
    const post = setup();
    const list = modernRequest("tools/list");
    list.body.params._meta["io.modelcontextprotocol/protocolVersion"] =
      "1900-01-01";
    const res = await post(list.body, {
      ...list.headers,
      "mcp-protocol-version": "1900-01-01",
    });
    expect(res.status).toBe(400);
    expect(res.body.id).toBe(1);
    expect(res.body.error).toMatchObject({
      code: -32022,
      data: { supported: ALL_VERSIONS, requested: "1900-01-01" },
    });

    // The client retries with a version from the list.
    const retry = modernRequest("tools/list");
    const ok = await post(retry.body, retry.headers);
    expect(ok.status).toBe(200);
  });

  it("answers an unsupported version named only by the header", async () => {
    const post = setup();
    const res = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "mcp-protocol-version": "2099-01-01" }
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: -32022,
      data: { supported: ALL_VERSIONS, requested: "2099-01-01" },
    });
  });

  it("still sends a notification 202 with no body", async () => {
    const post = setup();
    const res = await post(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
      {
        "mcp-protocol-version": MODERN,
        "mcp-method": "notifications/cancelled",
      }
    );
    expect(res.status).toBe(202);
  });
});

describe("/mcp, 2025-11-25", () => {
  it("negotiates the version and answers later requests from the header", async () => {
    const post = setup();
    const initialize = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "client", version: "1" },
      },
    });
    expect(initialize.status).toBe(200);
    expect(initialize.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "thebe-core", version: "9.9.9" },
      },
    });

    const initialized = await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-protocol-version": "2025-11-25" }
    );
    expect(initialized.status).toBe(202);

    const headers = {
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": "ignored",
    };
    const list = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      headers
    );
    expect(list.status).toBe(200);
    expect(Object.keys(list.body.result)).toEqual(["tools"]);
    expect(list.headers.get("mcp-session-id")).toBeNull();

    const call = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "container.status_summary", arguments: {} },
      },
      headers
    );
    expect(call.status).toBe(200);
    expect(call.body.result.resultType).toBeUndefined();
    expect(call.body.result.content[0].type).toBe("text");
  });
});

describe("/mcp, older recorded requests", () => {
  it("answers initialize for 2025-06-18 and 2025-03-26 as before", async () => {
    const post = setup();
    for (const version of ["2025-06-18", "2025-03-26"]) {
      const res = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: version },
      });
      expect(res.body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "thebe-core", version: "9.9.9" },
        },
      });
    }
    const unknown = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect(unknown.body.result.protocolVersion).toBe("2025-06-18");
  });

  it("answers an older request without a version header or _meta as before", async () => {
    const post = setup();
    const ping = await post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(Object.keys(list.body.result)).toEqual(["tools"]);
    expect(list.body.result.tools.length).toBeGreaterThan(0);

    const missing = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    expect(missing.status).toBe(200);
    expect(missing.body.error.code).toBe(-32601);

    const unnamed = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {},
    });
    expect(unnamed.status).toBe(200);
    expect(unnamed.body.error.code).toBe(-32602);
  });

  it("serves 2025-06-18 requests carrying the version header without checking Mcp-* headers", async () => {
    const post = setup();
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "container.status_summary", arguments: {} },
      },
      { "mcp-protocol-version": "2025-06-18" }
    );
    expect(res.status).toBe(200);
    expect(res.body.result.resultType).toBeUndefined();
    expect(res.body.result.content[0].type).toBe("text");
  });

  it("lists the same tools in a deterministic order for older clients too", async () => {
    const post = setup();
    const legacy = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const modern = modernRequest("tools/list");
    const newest = await post(modern.body, modern.headers);
    expect(legacy.body.result.tools).toEqual(newest.body.result.tools);
  });
});
