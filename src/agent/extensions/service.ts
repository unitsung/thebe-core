import { hashParameters } from "../security/audit/audit-log.ts";
import type { EnabledResource } from "../runtime/index.ts";
import type { AgentContext } from "../internal/context.ts";
import {
  listCoreMcpTools,
  withProductMetadata,
  type HomelabCapability,
  type McpServerInfo,
  type McpToolInfo,
} from "./mcp.ts";
import { toProductEnabledResource } from "./product.ts";
import { SERVICE_API_TOOL_NAMES } from "../capabilities/service-api.ts";
import { discoverSkills, importProjectSkill, parseSkillFrontmatter, readSkillDetails, skillContentHash, type SkillInfo } from "./skills.ts";
import type { AgentArtifact } from "../artifacts/types.ts";
import type { ArtifactStore } from "../artifacts/store.ts";

/** Skills and MCP extensions exposed through the stable Agent Interface. */
export function createExtensionApi(ctx: AgentContext, artifactStore: ArtifactStore) {
  const { enabledResources, workspacePath, audit, openedSessions, streaming } = ctx;
  const discover = () => discoverSkills({
    cwd: workspacePath, enabledResources,
    loadDirectory: ctx.options.runtime.loadSkillDirectory?.bind(ctx.options.runtime),
  });

  async function reloadIdleSessions(): Promise<void> {
    for (const id of openedSessions.keys()) ctx.resourcesNeedingReload.add(id);
    await Promise.all(
      [...openedSessions.entries()]
        .filter(([sessionId]) => !streaming.has(sessionId) && !ctx.promptLocks.has(sessionId))
        .map(async ([id, opened]) => {
          await opened.session.reloadResources?.();
          ctx.resourcesNeedingReload.delete(id);
        }),
    );
  }

  const listCapabilities = async (): Promise<HomelabCapability[]> => (
    [
      ...listCoreMcpTools({
        strmRepairProvider: ctx.options.strmRepairProvider,
        navidrome: Boolean(ctx.options.navidrome),
        musicResearch: Boolean(ctx.options.musicResearch),
        emby: Boolean(ctx.options.emby),
        jellyfin: Boolean(ctx.options.jellyfin),
        immich: Boolean(ctx.options.immich),
      }),
      ...ctx.baseTools()
        .filter(tool => (SERVICE_API_TOOL_NAMES as readonly string[]).includes(tool.name))
        .map((tool): HomelabCapability => ({
          id: tool.name, name: tool.name, description: tool.description,
          inputSchema: tool.parameters as Record<string, unknown>, category: "other", source: "core",
          serverName: "thebe-core", execution: "agent",
          permission: tool.name === "service_api_write" ? "confirm" : "read",
        })),
      ...(await ctx.mcp.listTools()),
    ].map(withProductMetadata)
  );

  async function putEnabledResource(resource: EnabledResource): Promise<EnabledResource> {
    const nextResources = enabledResources.filter(
      (item) => item.identity !== resource.identity,
    );
    nextResources.push(resource);
    await ctx.options.settingsStore?.save({ enabledResources: nextResources });
    enabledResources.splice(0, enabledResources.length, ...nextResources);
    await audit?.append({
      method: "resource.enable",
      parameterHash: hashParameters(resource),
      responseBytes: 0,
      budgetConsumed: 0,
      redactionFired: false,
      identity: resource.identity,
      version: resource.version,
      source: resource.source,
    });
    await reloadIdleSessions();
    return resource;
  }

  async function removeEnabledResource(identity: string): Promise<boolean> {
    const index = enabledResources.findIndex(
      (item) => item.identity === identity,
    );
    if (index < 0) return false;
    const nextResources = enabledResources.filter(
      (item) => item.identity !== identity,
    );
    await ctx.options.settingsStore?.save({ enabledResources: nextResources });
    enabledResources.splice(0, enabledResources.length, ...nextResources);
    await reloadIdleSessions();
    return true;
  }

  return {
    async importSkill(content: string): Promise<SkillInfo> {
      ctx.checkNotQuiesced();
      if (!workspacePath) throw new Error("Configure a workspace before importing skills");
      const name = parseSkillFrontmatter(content).name;
      if ((await discover()).some((skill) => skill.name === name)) throw new Error("Skill already exists");
      const skill = await importProjectSkill(workspacePath, content);
      await audit?.append({ method: "skill.import", parameterHash: skillContentHash(content),
        responseBytes: 0, budgetConsumed: 0, redactionFired: false, identity: skill.name });
      return skill;
    },
    async addMcpServer(input: import("./mcp.ts").McpServerRegistration): Promise<McpServerInfo> {
      ctx.checkNotQuiesced();
      if (!ctx.mcp.addServer) throw new Error("MCP registration is unavailable");
      const server = await ctx.mcp.addServer(input);
      await audit?.append({ method: "mcp.server.add", parameterHash: hashParameters(input),
        responseBytes: 0, budgetConsumed: 0, redactionFired: false, identity: server.name });
      return server;
    },
    async listSkills(): Promise<SkillInfo[]> {
      return discover();
    },
    async getSkill(name: string): Promise<SkillInfo | undefined> {
      const skills = await discover();
      const skill = skills.find((item) => item.name === name);
      if (!skill) return undefined;
      if (skill.filePath) {
        skill.content = await readSkillDetails(skill.filePath);
        skill.contentHash = skillContentHash(skill.content);
      }
      return skill;
    },
    async enableSkill(name: string): Promise<void> {
      const skill = (await discover())
        .find((item) => item.name === name);
      if (!skill) throw new Error(`unknown skill: ${name}`);
      if (skill.enabled) return;
      const resource: EnabledResource = {
        kind: "skill",
        identity: skill.name,
        version: skillContentHash(await readSkillDetails(skill.filePath)),
        source: skill.filePath || `thebe://skills/${skill.name}`,
      };
      await putEnabledResource(resource);
    },
    async disableSkill(name: string): Promise<void> {
      const index = enabledResources.findIndex(
        (resource) => resource.kind === "skill" && resource.identity === name,
      );
      if (index < 0) return;
      await removeEnabledResource(name);
    },
    listCapabilities,
    async listMcpTools(): Promise<McpToolInfo[]> { return listCapabilities(); },
    async listMcpServers(): Promise<McpServerInfo[]> {
      return ctx.mcp.listServers();
    },
    async setMcpServerEnabled(
      name: string,
      enabled: boolean,
    ): Promise<McpServerInfo | undefined> {
      const server = await ctx.mcp.setServerEnabled(name, enabled);
      if (!server) return undefined;
      const states = ctx.options.settingsStore?.load().mcpServerStates ?? [];
      const nextStates = states.filter((state) => state.name !== name);
      nextStates.push({ name, enabled });
      await ctx.options.settingsStore?.save({ mcpServerStates: nextStates });
      await audit?.append({
        method: enabled ? "mcp.server.enable" : "mcp.server.disable",
        parameterHash: hashParameters({ name, enabled }),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
        identity: name,
        source: `mcp://servers/${name}`,
      });
      await reloadIdleSessions();
      return server;
    },
    async checkMcpServer(name: string): Promise<McpServerInfo | undefined> {
      ctx.checkNotQuiesced();
      if (!ctx.mcp.checkServer) throw new Error("MCP health check is unavailable");
      const server = await ctx.mcp.checkServer(name);
      if (!server) return undefined;
      await audit?.append({ method: "mcp.server.check", parameterHash: hashParameters({ name }),
        responseBytes: 0, budgetConsumed: 0, redactionFired: false, identity: name,
        source: `mcp://servers/${name}` });
      return server;
    },
    async removeMcpServer(name: string): Promise<boolean> {
      ctx.checkNotQuiesced();
      if (!ctx.mcp.removeServer) throw new Error("MCP removal is unavailable");
      const removed = await ctx.mcp.removeServer(name);
      if (!removed) return false;
      const states = ctx.options.settingsStore?.load().mcpServerStates ?? [];
      if (states.some((state) => state.name === name)) {
        await ctx.options.settingsStore?.save({ mcpServerStates: states.filter((state) => state.name !== name) });
      }
      await audit?.append({ method: "mcp.server.remove", parameterHash: hashParameters({ name }),
        responseBytes: 0, budgetConsumed: 0, redactionFired: false, identity: name,
        source: `mcp://servers/${name}` });
      await reloadIdleSessions();
      return true;
    },
    closeMcp(): void {
      ctx.mcp.close();
    },
    async enableResource(resource: EnabledResource): Promise<void> {
      await putEnabledResource(resource);
    },
    putEnabledResource,
    removeEnabledResource,
    enabledResources(): EnabledResource[] {
      return enabledResources.slice();
    },
    async createEnabledResourceArtifact(): Promise<AgentArtifact> {
      return artifactStore.create({
        kind: "resource_list",
        title: "Enabled resources",
        contentType: "application/json",
        content: JSON.stringify({
          resources: enabledResources.map(toProductEnabledResource),
        }),
      });
    },
  };
}
