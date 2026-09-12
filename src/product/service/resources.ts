import { RESERVED_TOOLS } from "../../agent/subagent.ts";
import { hashParameters } from "../../audit/audit-log.ts";
import { createPolicyEngine } from "../../policy/policy-engine.ts";
import type { EnabledResource } from "../../runtime/types.ts";
import {
  discoverSkills,
  discoverSubagentProfiles,
  listCoreMcpTools,
  readSkillDetails,
  type McpToolInfo,
  type SkillInfo,
  type SubagentProfile,
} from "../resources/index.ts";
import type { SubagentRun } from "../types.ts";
import type { ProductContext } from "./context.ts";
import { createSubagentRunManager } from "./subagent-runs.ts";

const SUBAGENT_WRITE_TOOLS = new Set(["edit", "write"]);

export function createResourceApi(ctx: ProductContext) {
  const {
    options,
    enabledResources,
    checkNotQuiesced,
    lookup,
    sessionOptions,
    systemPrompt,
    openSession,
    audit,
    openedSessions,
    streaming,
    mcp,
    now,
    rejectPendingPermission,
    registerSubagentParentCanceller,
  } = ctx;

  const subagentRuns = createSubagentRunManager({
    now,
    maxConcurrent: options.maxSubagentConcurrency,
    maxPerParent: options.maxSubagentsPerParent,
    createSession: async ({ runId, parentSessionId, profile }) => {
      // A child receives only its profile and the explicit task. In
      // particular, it never uses the parent tools, transcript, labels, or
      // selected context as implicit input.
      const childTools = (profile.tools ?? []).filter(
        (name) =>
          !RESERVED_TOOLS.has(name) && !SUBAGENT_WRITE_TOOLS.has(name),
      );
      const childPolicy = createPolicyEngine({
        now,
        maxToolCalls: options.maxToolCalls,
        maxBlocks: options.maxBlocks,
      });
      childPolicy.beginRun();
      let stopChild: (() => Promise<void>) | undefined;
      const session = await options.runtime.createSession({
        ...sessionOptions(
          runId,
          childTools,
          profile.model,
          parentSessionId,
          undefined,
          childPolicy,
          `${ctx.callerId}:subagent:${runId}`,
          () => stopChild?.(),
        ),
        inMemory: true,
        autoCompact: false,
        systemPrompt: [
          systemPrompt,
          `# One-shot subagent (${profile.name})`,
          "You receive one explicit task only. Do not assume or reconstruct any parent conversation context.",
          profile.systemPrompt,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      stopChild = () => session.abort();
      return session;
    },
    emitToParent: (parentSessionId, event) => {
      // Most child events stay private. Permission requests are the one
      // exception: the parent is the only UI/control plane allowed to answer.
      if (event.type === "permission_requested") {
        ctx.appendEvent(parentSessionId, event);
      }
    },
    rejectPendingPermission,
  });
  registerSubagentParentCanceller(subagentRuns.cancelForParent);

  async function reloadIdleSessions(): Promise<void> {
    await Promise.all(
      [...openedSessions.entries()]
        .filter(([thebeSessionId]) => !streaming.has(thebeSessionId))
        .map(([, opened]) => opened.session.reloadResources?.()),
    );
  }

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
      await reloadIdleSessions();
    },
    async disableSkill(name: string): Promise<void> {
      const index = enabledResources.findIndex(
        (resource) => resource.kind === "skill" && resource.identity === name,
      );
      if (index >= 0) {
        enabledResources.splice(index, 1);
        await reloadIdleSessions();
      }
    },
    async listMcpTools(): Promise<McpToolInfo[]> {
      return [...listCoreMcpTools(), ...(await mcp.listTools())];
    },
    async listMcpServers(): Promise<
      Array<{
        name: string;
        command?: string;
        url?: string;
        status?: string;
        error?: string;
        toolCount?: number;
        disabled?: boolean;
      }>
    > {
      return mcp.listServers();
    },
    closeMcp(): void {
      mcp.close();
    },
    async listSubagentProfiles(): Promise<SubagentProfile[]> {
      return discoverSubagentProfiles();
    },
    async spawnSubagent(spawn: {
      profileName: string;
      taskPrompt: string;
      parentSessionId: string;
    }): Promise<SubagentRun> {
      checkNotQuiesced();
      const profiles = await discoverSubagentProfiles();
      const profile = profiles.find((item) => item.name === spawn.profileName);
      if (!profile) {
        throw new Error(`unknown subagent profile: ${spawn.profileName}`);
      }
      if (!spawn.taskPrompt.trim()) {
        throw new Error("subagent task cannot be empty");
      }
      // Lookup is validation only. The returned parent metadata is not passed
      // into the child, which is what makes inheritance opt-in impossible.
      await lookup(spawn.parentSessionId);
      return subagentRuns.spawn({
        profile,
        task: spawn.taskPrompt,
        parentSessionId: spawn.parentSessionId,
      });
    },
    listSubagents(parentSessionId?: string): SubagentRun[] {
      return subagentRuns.list(parentSessionId);
    },
    getSubagent(runId: string): SubagentRun | undefined {
      return subagentRuns.get(runId);
    },
    waitSubagent(runId: string): Promise<SubagentRun> {
      return subagentRuns.wait(runId);
    },
    cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun> {
      return subagentRuns.cancel(runId, parentSessionId);
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
