import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeHttpHandler } from "./handler.ts";

const MODERN_VERSION = "2026-07-28";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

function modernMeta(version = MODERN_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": {
      name: "protocol-test",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function modernHeaders(method: string, name?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "mcp-protocol-version": MODERN_VERSION,
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  };
}

function post(
  handler: ReturnType<typeof createThebeHttpHandler>,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" }
): Promise<Response> {
  return handler.handle(
    new Request("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("MCP protocol versions", () => {
  it("serves 2026-07-28 tools/list without initialize and caches it deterministically", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: modernMeta() },
    };

    const first = await post(handler, body, modernHeaders("tools/list"));
    expect(first.status).toBe(200);
    const firstResult = (await json(first)).result as {
      resultType?: string;
      tools?: Array<{ name?: string }>;
      ttlMs?: number;
      cacheScope?: string;
      _meta?: Record<string, unknown>;
    };
    expect(firstResult.resultType).toBe("complete");
    expect(firstResult.ttlMs).toBeGreaterThan(0);
    expect(firstResult.cacheScope).toBe("private");
    expect(firstResult._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "thebe-core",
      version: "9.9.9",
    });

    const names = (firstResult.tools ?? []).map((tool) => tool.name ?? "");
    expect(names).toEqual([...names].sort());

    const second = await post(handler, body, modernHeaders("tools/list"));
    const secondResult = (await json(second)).result as {
      tools?: Array<{ name?: string }>;
    };
    expect(secondResult.tools).toEqual(firstResult.tools);
  });

  it("implements server/discover with supported versions and cache hints", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const response = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: "discover",
        method: "server/discover",
        params: { _meta: modernMeta() },
      },
      modernHeaders("server/discover")
    );
    expect(response.status).toBe(200);
    const result = (await json(response)).result as {
      resultType?: string;
      supportedVersions?: string[];
      ttlMs?: number;
      cacheScope?: string;
      capabilities?: unknown;
    };
    expect(result.resultType).toBe("complete");
    expect(result.supportedVersions).toEqual(
      expect.arrayContaining([
        "2026-07-28",
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
      ])
    );
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe("public");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("serves a 2025-11-25 initialize handshake and keeps older fallbacks", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const initialize = await post(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "protocol-test", version: "1.0.0" },
      },
    });
    expect((await json(initialize)).result).toMatchObject({
      protocolVersion: "2025-11-25",
    });

    const list = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      }
    );
    expect(list.status).toBe(200);
    const result = (await json(list)).result as { resultType?: string };
    expect(result.resultType).toBeUndefined();

    const fallback = await post(handler, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect((await json(fallback)).result).toMatchObject({
      protocolVersion: "2025-06-18",
    });
  });

  it("rejects a mismatched modern protocol header with HeaderMismatch", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const response = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: modernMeta("2025-11-25") },
      },
      modernHeaders("tools/list")
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatchObject({ code: -32020 });
  });

  it("rejects a mismatched Mcp-Method or missing Mcp-Name", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const wrongMethod = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: modernMeta() },
      },
      modernHeaders("tools/call")
    );
    expect(wrongMethod.status).toBe(400);
    expect((await json(wrongMethod)).error).toMatchObject({ code: -32020 });

    const missingName = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "container_list", _meta: modernMeta() },
      },
      modernHeaders("tools/call")
    );
    expect(missingName.status).toBe(400);
    expect((await json(missingName)).error).toMatchObject({ code: -32020 });
  });

  it("returns UnsupportedProtocolVersionError with supported versions", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const response = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: modernMeta("2099-01-01") },
      },
      {
        "content-type": "application/json",
        "mcp-protocol-version": "2099-01-01",
        "mcp-method": "tools/list",
      }
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatchObject({
      code: -32022,
      data: {
        supported: expect.arrayContaining(["2026-07-28", "2025-11-25"]),
        requested: "2099-01-01",
      },
    });
  });

  it("requires client capabilities in modern per-request metadata", async () => {
    const handler = createThebeHttpHandler({ version: "9.9.9" });
    const response = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          },
        },
      },
      modernHeaders("tools/list")
    );
    expect(response.status).toBe(400);
    expect((await json(response)).error).toMatchObject({ code: -32602 });
  });

  it("returns a modern tools/call result without an initialize call", async () => {
    const { createFakeRuntime } =
      await import("../../testing/runtime/index.ts");
    const { createThebeApp } = await import("../../app/create.ts");
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "9.9.9",
    });
    const response = await post(
      app.handler,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_core_events",
          arguments: {},
          _meta: modernMeta(),
        },
      },
      modernHeaders("tools/call", "list_core_events")
    );
    expect(response.status).toBe(200);
    const result = (await json(response)).result as {
      resultType?: string;
      content?: Array<{ text?: string }>;
      _meta?: Record<string, unknown>;
    };
    expect(result.resultType).toBe("complete");
    expect(result.content?.[0]?.text).toBe("[]");
    expect(result._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "thebe-core",
      version: "9.9.9",
    });
  });
});
