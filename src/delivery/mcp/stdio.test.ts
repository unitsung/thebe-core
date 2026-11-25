import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeAgent } from "../../agent/index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createMcpStdioServer, serveMcpStdio } from "./stdio.ts";

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

describe("MCP stdio transport", () => {
  it("reuses the Core MCP tool list and invocation path without framing logs", async () => {
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const server = createMcpStdioServer({ agent, version: "9.9.9" });

    const initialized = JSON.parse(
      (await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "stdio-test", version: "1" },
          },
        })
      ))!
    );
    expect(initialized.result).toMatchObject({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "thebe-core", version: "9.9.9" },
    });

    const listed = JSON.parse(
      (await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        })
      ))!
    );
    expect(listed.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "container_list" }),
      ])
    );

    const modern = JSON.parse(
      (await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        })
      ))!
    );
    expect(modern.result).toMatchObject({
      resultType: "complete",
      ttlMs: expect.any(Number),
      cacheScope: "private",
    });

    const called = JSON.parse(
      (await server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "container_list", arguments: {} },
        })
      ))!
    );
    expect(called.result.isError).toBeUndefined();
    expect(called.result.content[0].text).toContain("\n[]\n");

    await expect(
      server.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        })
      )
    ).resolves.toBeUndefined();
    expect(JSON.parse((await server.handleLine("{broken"))!)).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
  });

  it("writes one protocol line per response and exits cleanly on EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));

    const served = serveMcpStdio({
      server: {
        async handleLine(line) {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: JSON.parse(line).id,
            result: {},
          });
        },
      },
      input,
      output,
    });
    input.end(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
    );
    await served;

    expect(
      chunks
        .join("")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    ).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  it("returns a JSON-RPC error instead of dropping an oversized line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const served = serveMcpStdio({
      server: {
        async handleLine() {
          throw new Error("oversized input must not reach the dispatcher");
        },
      },
      input,
      output,
      maxLineBytes: 8,
    });
    input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    await served;
    expect(JSON.parse(chunks.join("").trim())).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600 },
    });
  });
});
