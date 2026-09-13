import { createControlApi } from "./control/service.ts";
import { createPromptApi } from "./conversations/service.ts";
import { createGoalApi } from "./goals/service.ts";
import { createAgentContext } from "./internal/context.ts";
import type { CreateThebeAgentOptions, ThebeAgent } from "./interface.ts";
import { createExtensionApi } from "./extensions/service.ts";
import { createSessionApi } from "./sessions/service.ts";
import { createSubagentApi } from "./subagents/api.ts";

/** Authoritative composition root for the agent layer. */
export function createThebeAgent(options: CreateThebeAgentOptions): ThebeAgent {
  const ctx = createAgentContext(options);
  const extensions = createExtensionApi(ctx);
  const subagents = createSubagentApi(ctx);
  const goals = createGoalApi(ctx, subagents);
  const restoreSessionState = async (thebeSessionId: string): Promise<void> => {
    const meta = await ctx.lookup(thebeSessionId);
    subagents.restoreSubagents(thebeSessionId, meta.subagentRuns ?? []);
    goals.restoreGoal(meta.goalRun);
  };
  return {
    runtime: options.runtime,
    workspacePath: ctx.workspacePath,
    ...createPromptApi(ctx),
    ...createSessionApi(ctx, restoreSessionState),
    ...goals,
    ...extensions,
    ...subagents,
    ...createControlApi(ctx),
  };
}
