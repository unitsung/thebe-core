import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeAgent } from "../../agent/index.ts";
import type { McpRegistry } from "../../agent/extensions/mcp.ts";
import { createThebeApp } from "../../app/create.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { OpenApiDocument } from "./openapi.ts";

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

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("skills / MCP / resources / permission-mode product HTTP", () => {
  it("lists, gets, and patches skills without exposing file editing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-skills-http-"));
    await mkdir(join(dir, ".thebe", "skills", "demo-skill"), { recursive: true });
    await writeFile(
      join(dir, ".thebe", "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill\n---\nsecret skill body\n",
    );
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      workspacePath: dir,
    });
    const listed = await json(
      await app.handler.handle(new Request("http://127.0.0.1:8787/v1/skills")),
    );
    const skills = listed.skills as Array<Record<string, unknown>>;
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "demo-skill",
          description: "Demo skill",
          enabled: false,
        }),
      ]),
    );
    expect(JSON.stringify(listed)).not.toContain("secret skill body");

    const got = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/skills/demo-skill"),
      ),
    );
    expect(got.name).toBe("demo-skill");
    expect(got).not.toHaveProperty("content");
    expect(JSON.stringify(got)).not.toContain("secret skill body");

    const patched = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/skills/demo-skill", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(patched.status).toBe(200);
    const after = await json(patched);
    expect(after.enabled).toBe(true);
  });

  it("GET MCP servers and tools without speaking /mcp", async () => {
    const mcp: McpRegistry = {
      async listTools() {
        return [
          {
            id: "mcp:notes/echo",
            name: "mcp:notes/echo",
            description: "echo",
            inputSchema: { type: "object" },
            category: "other",
            permission: "read",
            source: "external",
            serverName: "notes",
          },
        ];
      },
      async listServers() {
        return [{ name: "notes", command: "notes-mcp", toolCount: 1 }];
      },
      async invokeTool() {
        return "ok";
      },
      close() {},
    };
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      mcp,
    });
    const handler = createThebeHttpHandler({ version: "0.1.0", agent });
    const servers = await json(
      await handler.handle(
        new Request("http://127.0.0.1:8787/v1/extensions/mcp/servers"),
      ),
    );
    expect(servers.servers).toEqual([
      expect.objectContaining({ name: "notes", command: "notes-mcp" }),
    ]);
    const tools = await json(
      await handler.handle(
        new Request("http://127.0.0.1:8787/v1/extensions/mcp/tools"),
      ),
    );
    const listed = tools.tools as Array<Record<string, unknown>>;
    expect(listed).toEqual([
      expect.objectContaining({
        id: "mcp:notes/echo",
        source: "external",
        serverName: "notes",
      }),
    ]);
    expect(listed.some((item) => item.id === "container.list")).toBe(false);
  });

  it("GET/PUT/DELETE enabled resources", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const empty = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/resources/enabled"),
      ),
    );
    expect(empty.resources).toEqual([]);

    const put = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/resources/enabled/demo-skill", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "skill",
          version: "1.0.0",
          source: "thebe://skills/demo-skill",
        }),
      }),
    );
    expect(put.status).toBe(200);
    const stored = await json(put);
    expect(stored).toEqual(
      expect.objectContaining({
        identity: "demo-skill",
        kind: "skill",
        version: "1.0.0",
        source: "thebe://skills/demo-skill",
      }),
    );

    const listed = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/resources/enabled"),
      ),
    );
    expect(listed.resources).toEqual([
      expect.objectContaining({ identity: "demo-skill" }),
    ]);

    const deleted = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/resources/enabled/demo-skill", {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(200);
    const after = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/resources/enabled"),
      ),
    );
    expect(after.resources).toEqual([]);
  });

  it("GET/PATCH permission mode", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const got = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/permissions"),
      ),
    );
    expect(got.mode).toBe("ask");
    const patched = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/permissions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "read-only" }),
      }),
    );
    expect(patched.status).toBe(200);
    expect((await json(patched)).mode).toBe("read-only");
    expect(app.agent.permissionMode()).toBe("read-only");
  });

  it("OpenAPI names the new product paths and schemas", async () => {
    const spec = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const body = (await spec.json()) as OpenApiDocument;
    const paths = [
      "/v1/capabilities/{id}/invoke",
      "/v1/capabilities/runs/{runId}",
      "/v1/subagents",
      "/v1/subagents/profiles",
      "/v1/subagents/{runId}",
      "/v1/subagents/{runId}/cancel",
      "/v1/subagents/{runId}/log",
      "/v1/permissions",
      "/v1/permissions/{id}",
      "/v1/permissions/{id}/resolve",
      "/v1/skills",
      "/v1/skills/{name}",
      "/v1/extensions/mcp/servers",
      "/v1/extensions/mcp/tools",
      "/v1/resources/enabled",
      "/v1/resources/enabled/{id}",
      "/v1/settings/permissions",
    ];
    for (const path of paths) {
      expect(body.paths[path], path).toBeDefined();
    }
    const schemas = body.components.schemas;
    for (const name of [
      "HomelabCapability",
      "CapabilityInvokeResult",
      "CapabilityRun",
      "ProductWorker",
      "PendingPermission",
      "PermissionResolution",
      "Skill",
      "McpServer",
      "McpTool",
      "EnabledResource",
      "PermissionModeSettings",
    ]) {
      expect(schemas[name], name).toBeDefined();
      expect(schemas[name]?.type).toBe("object");
    }
    const invokePost = body.paths["/v1/capabilities/{id}/invoke"]?.post as {
      responses?: Record<string, { content?: { "application/json"?: { schema?: unknown } } }>;
    };
    expect(JSON.stringify(invokePost.responses?.["200"])).toContain("CapabilityInvokeResult");
  });
});
