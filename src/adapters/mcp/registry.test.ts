import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
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
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "fixture-session");
      if (message.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } }));
      } else if (message.method === "tools/list") {
        expect(request.headers["mcp-session-id"]).toBe("fixture-session");
        expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }));
      } else if (message.method === "tools/call") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `http:${message.params?.arguments?.text ?? ""}` }] } }));
      } else {
        response.statusCode = 202;
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

  describe("server health checks", () => {
    const stdioScript = (toolsResponse: string) => [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  if (m.id === undefined) return;",
      "  if (m.method === 'initialize') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'f', version: '1' } } }) + '\\n');",
      `  if (m.method === 'tools/list') return process.stdout.write(JSON.stringify(${toolsResponse}) + '\\n');`,
      "});",
    ].join("\n");

    async function workspace(servers: Record<string, unknown>) {
      const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-health-cwd-"));
      const homeDir = await mkdtemp(join(tmpdir(), "thebe-mcp-health-home-"));
      await mkdir(join(cwd, ".thebe"), { recursive: true });
      await writeFile(join(cwd, ".thebe", "mcp.json"), JSON.stringify({ mcpServers: servers }));
      return { cwd, homeDir };
    }

    it("reports a ready server with checkedAt and a zero tool count", async () => {
      const dirs = await workspace({
        empty: { command: process.execPath, args: ["-e", stdioScript("{ jsonrpc: '2.0', id: m.id, result: { tools: [] } }")] },
      });
      const registry = createMcpClientRegistry({ ...dirs, timeoutMs: 5_000 });
      try {
        const [before] = await registry.listServers();
        expect(before).toEqual(expect.objectContaining({ name: "empty", status: "configured" }));
        expect(before?.checkedAt).toBeUndefined();
        expect(before?.toolCount).toBeUndefined();

        const checked = await registry.checkServer("empty");
        expect(checked).toEqual(expect.objectContaining({ name: "empty", status: "ready", toolCount: 0 }));
        expect(Number.isNaN(Date.parse(checked?.checkedAt ?? ""))).toBe(false);
        await expect(registry.listServers()).resolves.toEqual([
          expect.objectContaining({ status: "ready", toolCount: 0, checkedAt: checked?.checkedAt }),
        ]);
      } finally { registry.close(); }
    });

    it("records a redacted, bounded error when the probe fails", async () => {
      const secret = "supersecretvalue";
      const message = `upstream rejected TOKEN=${secret} ${"x".repeat(1000)}`;
      const dirs = await workspace({
        broken: { command: process.execPath, args: ["-e", stdioScript(`{ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: ${JSON.stringify(message)} } }`)] },
      });
      const registry = createMcpClientRegistry({ ...dirs, timeoutMs: 5_000 });
      try {
        const checked = await registry.checkServer("broken");
        expect(checked?.status).toBe("error");
        expect(checked?.checkedAt).toBeDefined();
        expect(checked?.toolCount).toBeUndefined();
        expect(checked?.error).toContain("upstream rejected");
        expect(checked?.error).not.toContain(secret);
        expect(checked?.error?.length).toBeLessThanOrEqual(300);
      } finally { registry.close(); }
    });

    it("never starts a disabled server when checking it", async () => {
      const dirs = await workspace({});
      const marker = join(dirs.cwd, "started");
      await writeFile(
        join(dirs.cwd, ".thebe", "mcp.json"),
        JSON.stringify({ mcpServers: { idle: {
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'); setTimeout(() => {}, 5000)`],
          disabled: true,
        } } }),
      );
      const registry = createMcpClientRegistry({ ...dirs, timeoutMs: 1_000 });
      try {
        await expect(registry.checkServer("idle")).resolves.toEqual(
          expect.objectContaining({ name: "idle", status: "disabled", disabled: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await expect(access(marker)).rejects.toThrow();
      } finally { registry.close(); }
    });

    const callScript = (onCall: string) => [
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line);",
      "  if (m.id === undefined) return;",
      "  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'f', version: '1' } } });",
      "  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'act', inputSchema: { type: 'object' } }] } });",
      `  if (m.method === 'tools/call') { ${onCall} }`,
      "});",
    ].join("\n");

    it("marks a server unreachable when it dies during a tool call", async () => {
      const dirs = await workspace({
        crashy: { command: process.execPath, args: ["-e", callScript("process.exit(1);")] },
      });
      const registry = createMcpClientRegistry({ ...dirs, timeoutMs: 5_000 });
      try {
        await registry.listTools();
        await expect(registry.listServers()).resolves.toEqual([
          expect.objectContaining({ status: "ready", toolCount: 1 }),
        ]);
        await expect(registry.invokeTool("mcp:crashy/act", {})).rejects.toThrow();
        const [after] = await registry.listServers();
        expect(after).toEqual(expect.objectContaining({ name: "crashy", status: "error" }));
        expect(after?.error).toBeTruthy();
        expect(after?.checkedAt).toBeDefined();
        expect(after?.toolCount).toBeUndefined();
      } finally { registry.close(); }
    });

    it("keeps a server ready when it answers a tool call with a JSON-RPC error", async () => {
      const dirs = await workspace({
        picky: { command: process.execPath, args: ["-e", callScript("send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'bad params' } });")] },
      });
      const registry = createMcpClientRegistry({ ...dirs, timeoutMs: 5_000 });
      try {
        await registry.listTools();
        await expect(registry.invokeTool("mcp:picky/act", {})).rejects.toThrow(/bad params/);
        await expect(registry.listServers()).resolves.toEqual([
          expect.objectContaining({ name: "picky", status: "ready", toolCount: 1 }),
        ]);
      } finally { registry.close(); }
    });

    it("returns undefined for an unknown server and clears the verdict on re-enable", async () => {
      const dirs = await workspace({
        one: { command: process.execPath, args: ["-e", stdioScript("{ jsonrpc: '2.0', id: m.id, result: { tools: [] } }")] },
      });
      const registry = createMcpClientRegistry({ ...dirs, timeoutMs: 5_000 });
      try {
        await expect(registry.checkServer("missing")).resolves.toBeUndefined();
        await registry.checkServer("one");
        await registry.setServerEnabled("one", false);
        await registry.setServerEnabled("one", true);
        const [after] = await registry.listServers();
        expect(after).toEqual(expect.objectContaining({ status: "configured" }));
        expect(after?.checkedAt).toBeUndefined();
        expect(after?.toolCount).toBeUndefined();
      } finally { registry.close(); }
    });
  });
});
