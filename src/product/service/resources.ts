import { randomUUID } from "node:crypto";
import { hashParameters } from "../../audit/audit-log.ts";
import type { EnabledResource } from "../../runtime/types.ts";
import {
  discoverSkills,
  discoverSubagentProfiles,
  listConfiguredMcpServers,
  listCoreMcpTools,
  readSkillDetails,
  type McpToolInfo,
  type SkillInfo,
  type SubagentProfile,
} from "../resources/index.ts";
import type { ProductSessionMeta } from "../store.ts";
import type { SessionRunStatus } from "../types.ts";
import type { ProductContext } from "./context.ts";

export function createResourceApi(ctx: ProductContext) {
  const {
    options,
    enabledResources,
    checkNotQuiesced,
    lookup,
    sessionOptions,
    systemPrompt,
    touchMeta,
    persist,
    runPrompt,
    listMetas,
    withRunState,
    openSession,
    audit,
  } = ctx;

  return {
    async listSkills(): Promise<SkillInfo[]> {
      return discoverSkills({ enabledResources });
    },
    async getSkill(name: string): Promise<SkillInfo | undefined> {
      const skills = await discoverSkills({ enabledResources });
      const skill = skills.find((item) => item.name === name);
      if (!skill) return undefined;
      if (skill.filePath) {
        skill.content = await readSkillDetails(skill.filePath);
      }
      return skill;
    },
    async enableSkill(name: string): Promise<void> {
      const skill = (await discoverSkills({ enabledResources })).find(
        (item) => item.name === name,
      );
      if (!skill) {
        throw new Error(`unknown skill: ${name}`);
      }
      if (skill.enabled) {
        return;
      }
      enabledResources.push({
        kind: "skill",
        identity: skill.name,
        version: "1.0.0",
        source: skill.filePath || `thebe://skills/${skill.name}`,
      });
      await audit?.append({
        method: "resource.enable",
        parameterHash: hashParameters({
          kind: "skill",
          identity: skill.name,
        }),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
        identity: skill.name,
        version: "1.0.0",
        source: skill.filePath || `thebe://skills/${skill.name}`,
      });
    },
    async disableSkill(name: string): Promise<void> {
      const index = enabledResources.findIndex(
        (resource) => resource.kind === "skill" && resource.identity === name,
      );
      if (index >= 0) {
        enabledResources.splice(index, 1);
      }
    },
    async listMcpTools(): Promise<McpToolInfo[]> {
      return listCoreMcpTools();
    },
    async listMcpServers(): Promise<
      Array<{ name: string; command?: string; url?: string }>
    > {
      const servers = await listConfiguredMcpServers();
      return servers.map((server) => ({
        name: server.name,
        command: server.command,
        url: server.url,
      }));
    },
    async listSubagentProfiles(): Promise<SubagentProfile[]> {
      return discoverSubagentProfiles();
    },
    async spawnSubagent(spawn: {
      profileName: string;
      taskPrompt?: string;
      parentSessionId: string;
    }): Promise<ProductSessionMeta> {
      checkNotQuiesced();
      const profiles = await discoverSubagentProfiles();
      const profile = profiles.find((item) => item.name === spawn.profileName);
      if (!profile) {
        throw new Error(`unknown subagent profile: ${spawn.profileName}`);
      }
      const parent = await lookup(spawn.parentSessionId);
      const previous = ctx.active;
      const extraPrompt = profile.systemPrompt
        ? `${systemPrompt}\n\n# Subagent: ${profile.name}\n${profile.systemPrompt}`
        : systemPrompt;
      const session = await options.runtime.createSession({
        ...sessionOptions(undefined, profile.tools ?? parent.builtinTools),
        systemPrompt: extraPrompt,
      });
      const meta = touchMeta({
        thebeSessionId: randomUUID(),
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: session.runtimeSessionId,
        parentThebeSessionId: parent.thebeSessionId,
        title: spawn.taskPrompt?.slice(0, 80) || profile.name,
        labels: {
          ...(parent.labels ?? {}),
          role: "subagent",
          profile: profile.name,
        },
        selectedContext: parent.selectedContext,
        builtinTools: profile.tools ? [...profile.tools] : parent.builtinTools,
      });
      await persist(meta);
      ctx.active = { meta, session };
      if (spawn.taskPrompt) {
        try {
          await runPrompt(spawn.taskPrompt, {
            thebeSessionId: meta.thebeSessionId,
          });
        } catch {
          // Child remains listed even if the first turn fails.
        }
      }
      ctx.active = previous ?? ctx.active;
      return meta;
    },
    async listSubagents(
      parentSessionId?: string,
    ): Promise<
      Array<ProductSessionMeta & { status: SessionRunStatus; streaming: boolean }>
    > {
      const rows = await listMetas();
      return rows
        .filter((row) =>
          parentSessionId
            ? row.parentThebeSessionId === parentSessionId
            : Boolean(row.parentThebeSessionId) ||
              row.labels?.role === "subagent",
        )
        .map((row) => withRunState(row));
    },
    async getForkMessages(
      thebeSessionId?: string,
    ): Promise<Array<{ entryId: string; text: string }>> {
      const opened = await openSession(thebeSessionId);
      if (typeof opened.session.getForkMessages === "function") {
        return opened.session.getForkMessages();
      }
      return opened.session
        .messages()
        .filter((message) => message.role === "user" && message.text)
        .map((message) => ({
          entryId: message.id,
          text: message.text ?? "",
        }));
    },
    async enableResource(resource: EnabledResource): Promise<void> {
      enabledResources.push(resource);
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
    },
    enabledResources(): EnabledResource[] {
      return enabledResources.slice();
    },
  };
}
