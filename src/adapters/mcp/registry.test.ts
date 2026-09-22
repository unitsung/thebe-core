import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpClientRegistry } from "./index.ts";

describe("external MCP client registry", () => {
  it("discovers and invokes a stdio MCP server", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-cwd-"));
    const homeDir = await mkdtemp(join(tmpdir(), "thebe-mcp-home-"));
    await mkdir(join(cwd, ".thebe"), { recursive: true });
    const serverScript = [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  if (m.id === undefined) return;",
      "  let result = {};",
      "  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } };",
      "  if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };",
      "  if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'echo:' + (m.params.arguments.text || '') }] };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');",
      "});",
    ].join("\n");
    await writeFile(
      join(cwd, ".thebe", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: {
            command: process.execPath,
            args: ["-e", serverScript],
            service: "qbittorrent",
            category: "photos",
            permission: "confirm",
          },
        },
      }),
    );

    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    process.chdir(cwd);
    process.env.HOME = homeDir;
    const registry = createMcpClientRegistry({ cwd, homeDir });
    try {
      const tools = await registry.listTools();
      expect(tools).toEqual([
        expect.objectContaining({
          name: "mcp:notes/echo",
          source: "external",
          serverName: "notes",
          service: "qbittorrent",
          category: "photos",
          permission: "confirm",
        }),
      ]);
      await expect(
        registry.invokeTool("mcp:notes/echo", { text: "ok" }),
      ).resolves.toBe("echo:ok");
      await expect(registry.listServers()).resolves.toEqual([
        expect.objectContaining({ name: "notes", status: "ready", toolCount: 1 }),
      ]);
      await expect(registry.setServerEnabled("notes", false)).resolves.toEqual(
        expect.objectContaining({ name: "notes", status: "disabled", disabled: true }),
      );
      await expect(registry.listTools()).resolves.toEqual([]);
      await expect(registry.setServerEnabled("notes", true)).resolves.toEqual(
        expect.objectContaining({ name: "notes", disabled: false }),
      );
      await expect(registry.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "mcp:notes/echo" }),
      ]);
      const restored = createMcpClientRegistry({
        cwd,
        homeDir,
        serverStates: [{ name: "notes", enabled: false }],
      });
      try {
        await expect(restored.listServers()).resolves.toEqual([
          expect.objectContaining({ name: "notes", status: "disabled", disabled: true }),
        ]);
        await expect(restored.listTools()).resolves.toEqual([]);
      } finally {
        restored.close();
      }
    } finally {
      registry.close();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("supports Streamable HTTP MCP servers with a session id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-http-cwd-"));
    const homeDir = await mkdtemp(join(tmpdir(), "thebe-mcp-http-home-"));
    await mkdir(join(cwd, ".thebe"), { recursive: true });
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "fixture-session");
      if (message.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }));
      } else if (message.method === "tools/list") {
        expect(request.headers["mcp-session-id"]).toBe("fixture-session");
        expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }));
      } else if (message.method === "tools/call") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `http:${message.params?.arguments?.text ?? ""}` }] } }));
      } else {
        response.statusCode = 204;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
    await writeFile(
      join(cwd, ".thebe", "mcp.json"),
      JSON.stringify({ mcpServers: { remote: { url: `http://127.0.0.1:${address.port}` } } }),
    );
    const registry = createMcpClientRegistry({ cwd, homeDir, timeoutMs: 2_000 });
    try {
      expect((await registry.listTools())[0]?.name).toBe("mcp:remote/echo");
      await expect(registry.invokeTool("mcp:remote/echo", { text: "ok" })).resolves.toBe("http:ok");
    } finally {
      registry.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
