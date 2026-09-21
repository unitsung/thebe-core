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
import { discoverSkills, readSkillDetails, type SkillInfo } from "./skills.ts";

/** Skills and MCP extensions exposed through the stable Agent Interface. */
export function createExtensionApi(ctx: AgentContext) {
  const { enabledResources, workspacePath, audit, openedSessions, streaming } = ctx;

  async function reloadIdleSessions(): Promise<void> {
    await Promise.all(
      [...openedSessions.entries()]
        .filter(([sessionId]) => !streaming.has(sessionId))
        .map(([, opened]) => opened.session.reloadResources?.()),
    );
  }

  const listCapabilities = async (): Promise<HomelabCapability[]> => (
    [...listCoreMcpTools(), ...(await ctx.mcp.listTools())].map(withProductMetadata)
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
    return true;
  }

  return {
    async listSkills(): Promise<SkillInfo[]> {
      return discoverSkills({ cwd: workspacePath, enabledResources });
    },
    async getSkill(name: string): Promise<SkillInfo | undefined> {
      const skills = await discoverSkills({ cwd: workspacePath, enabledResources });
      const skill = skills.find((item) => item.name === name);
      if (!skill) return undefined;
      if (skill.filePath) skill.content = await readSkillDetails(skill.filePath);
      return skill;
    },
    async enableSkill(name: string): Promise<void> {
      const skill = (await discoverSkills({ cwd: workspacePath, enabledResources }))
        .find((item) => item.name === name);
      if (!skill) throw new Error(`unknown skill: ${name}`);
      if (skill.enabled) return;
      const resource: EnabledResource = {
        kind: "skill",
        identity: skill.name,
        version: "1.0.0",
        source: skill.filePath || `thebe://skills/${skill.name}`,
      };
      await putEnabledResource(resource);
      await reloadIdleSessions();
    },
    async disableSkill(name: string): Promise<void> {
      const index = enabledResources.findIndex(
        (resource) => resource.kind === "skill" && resource.identity === name,
      );
      if (index < 0) return;
      await removeEnabledResource(name);
      await reloadIdleSessions();
    },
    listCapabilities,
    async listMcpTools(): Promise<McpToolInfo[]> { return listCapabilities(); },
    async listMcpServers(): Promise<McpServerInfo[]> {
      return ctx.mcp.listServers();
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
  };
}
