import { RESERVED_SUBAGENT_TOOLS } from "./profiles.ts";
import { createPolicyEngine } from "../../agent/security/policy/policy-engine.ts";
import type { SubagentRun, SubagentUpdate } from "../types.ts";
import type { AgentContext } from "../internal/context.ts";
import { discoverSubagentProfiles, type SubagentProfile } from "./catalog.ts";
import { createSubagentRunManager } from "./service.ts";
import type { ArtifactStore } from "../artifacts/store.ts";

const SUBAGENT_WRITE_TOOLS = new Set(["edit", "write"]);

export function createSubagentApi(
  ctx: AgentContext,
  artifactStore?: ArtifactStore,
) {
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

  async function persistSubagentSnapshot(run: SubagentRun): Promise<void> {
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
    onSnapshot: persistSubagentSnapshot,
    beforeTerminal: async (run) => {
      if (
        artifactStore &&
        !run.artifactId &&
        (run.status === "completed" || run.status === "failed")
      ) {
        const content = workerReport(run.result ?? run.responseText);
        if (content) {
          try {
            const artifact = await artifactStore.create({
              kind: "report",
              title: `Worker report: ${run.profileName}`,
              content,
              contentType: "text/plain; charset=utf-8",
              sessionId: run.parentSessionId,
              runId: run.runId,
            });
            run.artifactId = artifact.artifactId;
          } catch {
            // A report Artifact is supplementary; the Worker remains usable.
          }
        }
      }
    },
    onTerminal: persistSubagentSnapshot,
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
      const run = subagentRuns.spawn({ profile, task: spawn.taskPrompt, parentSessionId: spawn.parentSessionId });
      void persistSubagentSnapshot(run);
      return run;
    },
    async listSubagents(parentSessionId?: string): Promise<SubagentRun[]> {
      const metas = await ctx.listMetas();
      const recovered: SubagentRun[] = [];
      for (const meta of metas) {
        recovered.push(...subagentRuns.restore(meta.subagentRuns ?? []));
      }
      await Promise.all(recovered.map(persistSubagentSnapshot));
      return subagentRuns.list(parentSessionId);
    },
    restoreSubagents(parentSessionId: string, restoredRuns: SubagentRun[]): void {
      const recovered = subagentRuns.restore(
        restoredRuns.filter((run) => run.parentSessionId === parentSessionId),
      );
      void Promise.all(recovered.map(persistSubagentSnapshot));
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

const MAX_WORKER_REPORT_LENGTH = 12_000;

function workerReport(value: string | undefined): string | undefined {
  const content = value?.trim();
  if (!content) return undefined;
  return content.length <= MAX_WORKER_REPORT_LENGTH
    ? content
    : `${content.slice(0, MAX_WORKER_REPORT_LENGTH)}\n…`;
}
