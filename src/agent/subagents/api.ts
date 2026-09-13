import { RESERVED_SUBAGENT_TOOLS } from "./profiles.ts";
import { createPolicyEngine } from "../../agent/security/policy/policy-engine.ts";
import type { SubagentRun, SubagentUpdate } from "../types.ts";
import type { AgentContext } from "../internal/context.ts";
import { discoverSubagentProfiles, type SubagentProfile } from "./catalog.ts";
import { createSubagentRunManager } from "./service.ts";

const SUBAGENT_WRITE_TOOLS = new Set(["edit", "write"]);

export function createSubagentApi(ctx: AgentContext) {
  const {
    options,
    checkNotQuiesced,
    lookup,
    sessionOptions,
    systemPrompt,
    now,
    rejectPendingPermission,
    registerSubagentParentCanceller,
    workspacePath,
    persist,
    touchMeta,
  } = ctx;
  const subagentPersistence = new Map<string, Promise<void>>();

  async function persistTerminalSubagent(run: SubagentRun): Promise<void> {
    const previous = subagentPersistence.get(run.parentSessionId) ?? Promise.resolve();
    const current = previous.then(async () => {
      try {
        const meta = await lookup(run.parentSessionId);
        const previousRuns = meta.subagentRuns ?? [];
        const next = [...previousRuns.filter((item) => item.runId !== run.runId), run].slice(-100);
        await persist(touchMeta({ ...meta, subagentRuns: next }));
      } catch {
        // Persistence is best-effort; the in-memory task record remains usable.
      }
    });
    subagentPersistence.set(run.parentSessionId, current);
    await current;
    if (subagentPersistence.get(run.parentSessionId) === current) {
      subagentPersistence.delete(run.parentSessionId);
    }
  }

  const subagentRuns = createSubagentRunManager({
    now,
    maxConcurrent: options.maxSubagentConcurrency,
    maxPerParent: options.maxSubagentsPerParent,
    createSession: async ({ runId, parentSessionId, profile }) => {
      const childTools = (profile.tools ?? []).filter(
        (name) => !RESERVED_SUBAGENT_TOOLS.has(name) &&
          (profile.allowWrites || !SUBAGENT_WRITE_TOOLS.has(name)),
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
        ].filter(Boolean).join("\n\n"),
      });
      stopChild = () => session.abort();
      return session;
    },
    emitToParent: (parentSessionId, event) => {
      if (event.type === "permission_requested") ctx.appendEvent(parentSessionId, event);
    },
    rejectPendingPermission,
    onTerminal: persistTerminalSubagent,
  });
  registerSubagentParentCanceller(subagentRuns.cancelForParent);

  return {
    async listSubagentProfiles(): Promise<SubagentProfile[]> {
      return discoverSubagentProfiles({ cwd: workspacePath });
    },
    async spawnSubagent(spawn: {
      profileName: string;
      taskPrompt: string;
      parentSessionId: string;
    }): Promise<SubagentRun> {
      checkNotQuiesced();
      const profiles = await discoverSubagentProfiles({ cwd: workspacePath });
      const profile = profiles.find((item) => item.name === spawn.profileName);
      if (!profile) throw new Error(`unknown subagent profile: ${spawn.profileName}`);
      if (!spawn.taskPrompt.trim()) throw new Error("subagent task cannot be empty");
      await lookup(spawn.parentSessionId);
      return subagentRuns.spawn({ profile, task: spawn.taskPrompt, parentSessionId: spawn.parentSessionId });
    },
    listSubagents(parentSessionId?: string): SubagentRun[] {
      return subagentRuns.list(parentSessionId);
    },
    restoreSubagents(parentSessionId: string, restoredRuns: SubagentRun[]): void {
      subagentRuns.restore(restoredRuns.filter((run) => run.parentSessionId === parentSessionId));
    },
    getSubagent(runId: string): SubagentRun | undefined {
      return subagentRuns.get(runId);
    },
    subscribeSubagent(runId: string, listener: (update: SubagentUpdate) => void): () => void {
      return subagentRuns.subscribe(runId, listener);
    },
    subscribeSubagents(parentSessionId: string | undefined, listener: (update: SubagentUpdate) => void): () => void {
      return subagentRuns.subscribeAll(parentSessionId, listener);
    },
    waitSubagent(runId: string): Promise<SubagentRun> {
      return subagentRuns.wait(runId);
    },
    cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun> {
      return subagentRuns.cancel(runId, parentSessionId);
    },
  };
}
