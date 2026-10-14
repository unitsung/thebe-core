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
      })
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
        registry.invokeTool("mcp:notes/echo", { text: "ok" })
      ).resolves.toBe("echo:ok");
      await expect(registry.listServers()).resolves.toEqual([
        expect.objectContaining({
          name: "notes",
          status: "configured",
          disabled: false,
        }),
      ]);
      await expect(registry.setServerEnabled("notes", false)).resolves.toEqual(
        expect.objectContaining({
          name: "notes",
          status: "disabled",
          disabled: true,
        })
      );
      await expect(registry.listTools()).resolves.toEqual([]);
      await expect(registry.setServerEnabled("notes", true)).resolves.toEqual(
        expect.objectContaining({ name: "notes", disabled: false })
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
          expect.objectContaining({
            name: "notes",
            status: "disabled",
            disabled: true,
          }),
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
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        params?: { arguments?: { text?: string } };
      };
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "fixture-session");
      if (message.method === "initialize") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1.0.0" },
            },
          })
        );
      } else if (message.method === "tools/list") {
        expect(request.headers["mcp-session-id"]).toBe("fixture-session");
        expect(request.headers["mcp-protocol-version"]).toBe("2025-06-18");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{ name: "echo", inputSchema: { type: "object" } }],
            },
          })
        );
      } else if (message.method === "tools/call") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `http:${message.params?.arguments?.text ?? ""}`,
                },
              ],
            },
          })
        );
      } else {
        response.statusCode = 202;
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP fixture did not bind");
    await writeFile(
      join(cwd, ".thebe", "mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { url: `http://127.0.0.1:${address.port}` } },
      })
    );
    const registry = createMcpClientRegistry({
      cwd,
      homeDir,
      timeoutMs: 2_000,
    });
    try {
      expect((await registry.listTools())[0]?.name).toBe("mcp:remote/echo");
      await expect(
        registry.invokeTool("mcp:remote/echo", { text: "ok" })
      ).resolves.toBe("http:ok");
    } finally {
      registry.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("hands the runtime the configured servers with the saved enabled state, and runs stdio servers without Core's environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-runtime-cwd-"));
    const homeDir = await mkdtemp(join(tmpdir(), "thebe-mcp-runtime-home-"));
    await mkdir(join(cwd, ".thebe"), { recursive: true });
    const script = [
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const m = JSON.parse(line); if (m.id === undefined) return;",
      "  let result = {};",
      "  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'f', version: '1' } };",
      "  if (m.method === 'tools/list') result = { tools: [{ name: 'env', inputSchema: { type: 'object' } }] };",
      "  if (m.method === 'tools/call') result = { content: [{ type: 'text', text: (process.env.THEBE_TEST_SECRET || 'absent') + ' ' + (process.env.OWN || '') }] };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');",
      "});",
    ].join("\n");
    await writeFile(
      join(cwd, ".thebe", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          notes: {
            command: process.execPath,
            args: ["-e", script],
            env: { OWN: "own" },
            exposure: "direct",
            description: "Notes",
            permission: "confirm",
          },
          off: { url: "http://127.0.0.1:1/mcp", disabled: true },
        },
      })
    );
    process.env.THEBE_TEST_SECRET = "must-not-reach-mcp";
    const registry = createMcpClientRegistry({
      cwd,
      homeDir,
      serverStates: [{ name: "off", enabled: true }],
    });
    try {
      expect(registry.runtimeServers()).toEqual([
        expect.objectContaining({
          name: "notes",
          enabled: true,
          exposure: "direct",
          description: "Notes",
          permission: "confirm",
          env: { OWN: "own" },
        }),
        expect.objectContaining({ name: "off", enabled: true }),
      ]);
      await registry.setServerEnabled("notes", false);
      expect(
        registry.runtimeServers().find((server) => server.name === "notes")
          ?.enabled
      ).toBe(false);
      await registry.setServerEnabled("notes", true);
      await expect(registry.invokeTool("mcp:notes/env", {})).resolves.toBe(
        "absent own"
      );
    } finally {
      delete process.env.THEBE_TEST_SECRET;
      registry.close();
    }
  });

  it("carries a server's own custom headers to the wire and keeps them across registration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-headers-cwd-"));
    const homeDir = await mkdtemp(join(tmpdir(), "thebe-mcp-headers-home-"));
    await mkdir(join(cwd, ".thebe"), { recursive: true });
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer(async (request, response) => {
      seen.push(request.headers);
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as { id?: number; method?: string };
      response.setHeader("content-type", "application/json");
      if (message.method === "initialize") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          })
        );
      } else if (message.method === "tools/list") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{ name: "ping", inputSchema: { type: "object" } }],
            },
          })
        );
      } else {
        response.statusCode = 202;
        response.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP fixture did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(cwd, ".thebe", "mcp.json"),
      JSON.stringify({
        mcpServers: { music: { url, headers: { "X-Sqmusic": "jwt-token" } } },
      })
    );
    const registry = createMcpClientRegistry({
      cwd,
      homeDir,
      timeoutMs: 2_000,
    });
    try {
      expect((await registry.listTools())[0]?.name).toBe("mcp:music/ping");
      expect(seen.some((headers) => headers["x-sqmusic"] === "jwt-token")).toBe(
        true
      );
      expect(
        registry.runtimeServers().find((entry) => entry.name === "music")
          ?.headers
      ).toEqual({ "X-Sqmusic": "jwt-token" });

      // A provider MCP registered through the product path carries its headers too;
      // it starts disabled until enabled explicitly.
      await expect(
        registry.addServer({
          name: "extra",
          url,
          headers: { "X-Api-Key": "k" },
        })
      ).resolves.toMatchObject({ name: "extra", disabled: true });
      expect(
        registry.runtimeServers().find((entry) => entry.name === "extra")
          ?.headers
      ).toEqual({ "X-Api-Key": "k" });
      await registry.setServerEnabled("extra", true);
      expect(
        registry.runtimeServers().find((entry) => entry.name === "extra")
          ?.enabled
      ).toBe(true);

      // Description and exposure survive registration so a search server can be made loadable by tool_search.
      await registry.addServer({ name: "findable", url, description: "Web search", exposure: "deferred" });
      expect(registry.runtimeServers().find((entry) => entry.name === "findable")).toMatchObject({
        description: "Web search",
        exposure: "deferred",
      });
      await expect(registry.addServer({ name: "bad", url, exposure: "everywhere" as never })).rejects.toThrow("exposure");
      expect((await registry.listTools()).map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["mcp:music/ping", "mcp:extra/ping"])
      );
    } finally {
      registry.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
