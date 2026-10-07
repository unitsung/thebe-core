import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { createJsonAgentSettingsStore } from "../../agent/settings/store.ts";

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
  it("imports disabled skills, preserves them across recreation, and refuses traversal or replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-skill-import-"));
    const app = createThebeApp({ runtime: createFakeRuntime().runtime, provider: provider(), workspacePath: dir });
    const content = "---\nname: nas-check\ndescription: Read-only NAS inspection\n---\nInspect status without making changes.\n";
    const post = (text: string) => app.handler.handle(new Request("http://127.0.0.1:8787/v1/skills", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text }),
    }));
    expect(await json(await post(content))).toMatchObject({ name: "nas-check", enabled: false, scope: "project" });
    expect((await post(content.replace("Read-only NAS inspection", "Changed"))).status).toBe(400);
    expect((await post(content.replace("nas-check", "../escape"))).status).toBe(400);
    expect((await post("x".repeat(1_048_577))).status).toBe(400);
    expect(await readFile(join(dir, ".thebe", "skills", "nas-check.md"), "utf8")).toBe(content);
    const recreated = createThebeApp({ runtime: createFakeRuntime().runtime, provider: provider(), workspacePath: dir });
    expect(await recreated.agent.getSkill("nas-check")).toMatchObject({ name: "nas-check", enabled: false, content });
    await app.agent.quiesce();
    expect((await post(content.replace("nas-check", "another"))).status).toBe(503);
    app.agent.closeMcp(); recreated.agent.closeMcp();
  });

  it("adds durable disabled MCP servers without leaking credentials or replacing existing configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-mcp-add-"));
    await mkdir(join(dir, ".thebe"));
    await writeFile(join(dir, ".thebe", "mcp.json"), JSON.stringify({ note: "preserved", mcpServers: { existing: { url: "http://127.0.0.1:1/mcp", disabled: true } } }));
    const app = createThebeApp({ runtime: createFakeRuntime().runtime, provider: provider(), workspacePath: dir });
    const post = (body: unknown) => app.handler.handle(new Request("http://127.0.0.1:8787/v1/extensions/mcp/servers", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    const response = await post({ name: "notes", url: "http://127.0.0.1:2/mcp", headers: { Authorization: "Bearer fixture-secret" } });
    expect(response.status).toBe(201);
    const result = await json(response);
    expect(result).toMatchObject({ name: "notes", status: "disabled", disabled: true });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.parse(await readFile(join(dir, ".thebe", "mcp.json"), "utf8"))).toMatchObject({ note: "preserved", mcpServers: { existing: { disabled: true }, notes: { disabled: true } } });
    expect((await post({ name: "notes", command: "unused" })).status).toBe(400);
    expect((await post({ name: "../escape", command: "unused" })).status).toBe(400);
    expect((await post({ name: "invalid", url: "file:///tmp/test" })).status).toBe(400);
    expect((await post({ name: "invalid", command: "unused", args: [42] })).status).toBe(400);
    const recreated = createThebeApp({ runtime: createFakeRuntime().runtime, provider: provider(), workspacePath: dir });
    expect(await recreated.agent.listMcpServers()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "notes", disabled: true })]));
    app.agent.closeMcp(); recreated.agent.closeMcp();
  });
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
    const content = await json(await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/skills/demo-skill/content"),
    ));
    expect(content).toMatchObject({ name: "demo-skill", content: expect.stringContaining("secret skill body") });
    expect(content.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(content).not.toHaveProperty("filePath");
    expect((await app.handler.handle(new Request("http://127.0.0.1:8787/v1/skills/unknown/content"))).status).toBe(404);

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
      async setServerEnabled(name: string, enabled: boolean) {
        return { name, status: enabled ? "configured" : "disabled", disabled: !enabled };
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

  it("PATCHes an MCP server enabled state and persists the product setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-mcp-toggle-http-"));
    const settingsStore = createJsonAgentSettingsStore(join(dir, "config.json"));
    const calls: Array<{ name: string; enabled: boolean }> = [];
    const mcp = {
      async listTools() { return []; },
      async listServers() {
        return [{ name: "notes", status: "ready", disabled: false }];
      },
      async setServerEnabled(name: string, enabled: boolean) {
        calls.push({ name, enabled });
        return { name, status: enabled ? "configured" : "disabled", disabled: !enabled };
      },
      async invokeTool() { return "ok"; },
      close() {},
    };
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      mcp,
      settingsStore,
    });
    const handler = createThebeHttpHandler({ version: "0.1.0", agent });

    const response = await handler.handle(
      new Request("http://127.0.0.1:8787/v1/extensions/mcp/servers/notes", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(
      expect.objectContaining({ name: "notes", disabled: true }),
    );
    expect(calls).toEqual([{ name: "notes", enabled: false }]);
    expect(settingsStore.load().mcpServerStates).toEqual([
      { name: "notes", enabled: false },
    ]);
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

  it("restores enabled resources after the HTTP App is recreated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-resources-http-config-"));
    const settingsStore = createJsonAgentSettingsStore(join(dir, "config.json"));
    const first = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      settingsStore,
    });

    const put = await first.handler.handle(
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

    const second = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      settingsStore,
    });
    const listed = await json(
      await second.handler.handle(
        new Request("http://127.0.0.1:8787/v1/resources/enabled"),
      ),
    );

    expect(listed.resources).toEqual([
      expect.objectContaining({
        identity: "demo-skill",
        kind: "skill",
      }),
    ]);
  });

  it("captures enabled resources as a durable resource-list Artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-resource-artifact-http-"));
    const settingsStore = createJsonAgentSettingsStore(join(dir, "config.json"));
    const first = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: join(dir, "agent"),
      settingsStore,
    });

    const put = await first.handler.handle(
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

    const captured = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/resources/enabled/artifact", {
        method: "POST",
      }),
    );
    expect(captured.status).toBe(200);
    const artifact = await json(captured);
    expect(artifact).toEqual(
      expect.objectContaining({
        kind: "resource_list",
        title: "Enabled resources",
        contentType: "application/json",
      }),
    );

    const artifactId = artifact.artifactId as string;
    const content = await json(
      await first.handler.handle(
        new Request(`http://127.0.0.1:8787/v1/artifacts/${artifactId}/content`),
      ),
    );
    expect(JSON.parse(content.content as string)).toEqual({
      resources: [
        {
          identity: "demo-skill",
          kind: "skill",
          version: "1.0.0",
          source: "thebe://skills/demo-skill",
        },
      ],
    });

    await first.agent.quiesce();
    const blocked = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/resources/enabled/artifact", {
        method: "POST",
      }),
    );
    expect(blocked.status).toBe(503);
    await first.agent.unquiesce();

    const second = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      agentStoreDir: join(dir, "agent"),
      settingsStore,
    });
    const listed = await json(
      await second.handler.handle(
        new Request("http://127.0.0.1:8787/v1/artifacts?kind=resource_list"),
      ),
    );
    expect(listed.artifacts).toEqual([
      expect.objectContaining({ artifactId, kind: "resource_list" }),
    ]);
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
      "/v1/capabilities/runs",
      "/v1/capabilities/runs/{runId}",
      "/v1/capabilities/runs/{runId}/log",
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
      "/v1/extensions/mcp/servers/{name}",
      "/v1/extensions/mcp/tools",
      "/v1/resources/enabled",
      "/v1/resources/enabled/{id}",
      "/v1/resources/enabled/artifact",
      "/v1/settings/permissions",
      "/v1/settings/agent",
    ];
    for (const path of paths) {
      expect(body.paths[path], path).toBeDefined();
    }
    const schemas = body.components.schemas;
    for (const name of [
      "HomelabCapability",
      "CapabilityInvokeResult",
      "CapabilityRun",
      "CapabilityRunList",
      "ProductWorker",
      "PendingPermission",
      "PermissionResolution",
      "Skill",
      "McpServer",
      "McpTool",
      "EnabledResource",
      "PermissionModeSettings",
      "AgentSettings",
      "AgentSettingsPatch",
    ]) {
      expect(schemas[name], name).toBeDefined();
      expect(schemas[name]?.type).toBe("object");
    }
    const capabilityRun = schemas.CapabilityRun as {
      properties?: {
        status?: { enum?: string[] };
        recovery?: { enum?: string[] };
      };
    };
    expect(capabilityRun.properties?.status?.enum).toContain("interrupted");
    expect(capabilityRun.properties?.recovery?.enum).toEqual(["restored", "interrupted"]);
    const invokePost = body.paths["/v1/capabilities/{id}/invoke"]?.post as {
      responses?: Record<string, { content?: { "application/json"?: { schema?: unknown } } }>;
    };
    expect(JSON.stringify(invokePost.responses?.["200"])).toContain("CapabilityInvokeResult");
    const invokeResult = schemas.CapabilityInvokeResult as {
      properties?: { artifactId?: { type?: string } };
    };
    expect(invokeResult.properties?.artifactId).toEqual(
      expect.objectContaining({ type: "string" }),
    );
    expect(body.paths["/v1/extensions/mcp/servers/{name}"]?.patch).toBeDefined();
    expect(schemas.McpServerPatch).toEqual(
      expect.objectContaining({ required: ["enabled"] }),
    );
  });

  it("advertises product capability categories for infrastructure and photos", async () => {
    const spec = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const body = (await spec.json()) as OpenApiDocument;
    const capability = body.components.schemas.HomelabCapability as {
      properties?: { category?: { enum?: string[] } };
    };

    expect(capability.properties?.category?.enum).toEqual(
      expect.arrayContaining(["compute", "storage", "network", "photos"]),
    );
  });
});
