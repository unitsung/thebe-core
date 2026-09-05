import { CONTAINER_TOOL_NAMES } from "../tools/container-tools.ts";

const LOGS_DAILY_LIMIT = 1000;

const BUDGET_EXHAUSTED_REASON =
  "Budget exhausted. Do not call any more tools; write the final answer from what you already have.";

/** Per-Run counters and latches. Reset by beginRun() before each Ask. */
export type PolicyRunState = {
  toolCalls: number;
  blocks: number;
  denyLatch: boolean;
  violationLatch: boolean;
};

export function createPolicyRunState(): PolicyRunState {
  return { toolCalls: 0, blocks: 0, denyLatch: false, violationLatch: false };
}

/**
 * Pure policy decision from a snapshot. No IO, Map, or clock.
 * Returns allow/block+reason only; stopping the Run is shouldStopAfterTurn.
 */
export function decide(input: {
  toolName: string;
  runState: PolicyRunState;
  maxToolCalls: number;
  maxBlocks: number;
}): { allow: true } | { allow: false; reason: string } {
  if (
    !(CONTAINER_TOOL_NAMES as readonly string[]).includes(input.toolName)
  ) {
    return { allow: false, reason: `unknown tool: ${input.toolName}` };
  }
  if (input.runState.denyLatch || input.runState.violationLatch) {
    return { allow: false, reason: BUDGET_EXHAUSTED_REASON };
  }
  if (input.runState.toolCalls >= input.maxToolCalls) {
    return { allow: false, reason: BUDGET_EXHAUSTED_REASON };
  }
  if (input.runState.blocks >= input.maxBlocks) {
    return { allow: false, reason: BUDGET_EXHAUSTED_REASON };
  }
  return { allow: true };
}

export function createPolicyEngine(options: {
  now: () => Date;
  maxToolCalls?: number;
  maxBlocks?: number;
}) {
  const logsByDayAndCaller = new Map<string, number>();
  const maxToolCalls = options.maxToolCalls ?? 50;
  const maxBlocks = options.maxBlocks ?? 3;
  // Mutable per-Run state. Hooks close over this; beginRun() resets it.
  let run: PolicyRunState = createPolicyRunState();

  function noteBlock(): void {
    run.blocks += 1;
    if (run.blocks >= maxBlocks) {
      run.violationLatch = true;
    }
  }

  return {
    beginRun(): void {
      run = createPolicyRunState();
    },
    runSnapshot(): PolicyRunState {
      return { ...run };
    },
    allow(
      name: string,
      callerId: string,
    ): { ok: true; budgetConsumed: number } | { ok: false; reason: string } {
      if (
        !(CONTAINER_TOOL_NAMES as readonly string[]).includes(name)
      ) {
        return { ok: false, reason: `unknown tool: ${name}` };
      }
      if (name !== "container.logs") {
        return { ok: true, budgetConsumed: 0 };
      }
      const day = options.now().toISOString().slice(0, 10);
      const key = `${day}:${callerId}`;
      const used = logsByDayAndCaller.get(key) ?? 0;
      if (used >= LOGS_DAILY_LIMIT) {
        return { ok: false, reason: "container.logs daily budget exceeded" };
      }
      logsByDayAndCaller.set(key, used + 1);
      return { ok: true, budgetConsumed: 1 };
    },
    /**
     * Fail-closed: a throw here still blocks. Do not set terminate;
     * the loop stops via shouldStopAfterTurn.
     */
    async beforeToolCall(context: {
      toolCall: { name: string };
    }): Promise<{ block?: boolean; reason?: string }> {
      try {
        const decision = decide({
          toolName: context.toolCall.name,
          runState: run,
          maxToolCalls,
          maxBlocks,
        });
        run.toolCalls += 1;
        if (!decision.allow) {
          if (
            decision.reason === BUDGET_EXHAUSTED_REASON &&
            !run.denyLatch &&
            !run.violationLatch
          ) {
            if (run.toolCalls - 1 >= maxToolCalls) {
              run.denyLatch = true;
            } else {
              run.violationLatch = true;
            }
          }
          noteBlock();
          return { block: true, reason: decision.reason };
        }
        if (run.toolCalls >= maxToolCalls) {
          run.denyLatch = true;
        }
        return {};
      } catch (error) {
        noteBlock();
        return {
          block: true,
          reason:
            error instanceof Error ? error.message : "policy hook failed",
        };
      }
    },
    /** Must not throw. True after deny/violation latch; this is how a Run stops. */
    async shouldStopAfterTurn(): Promise<boolean> {
      try {
        return run.denyLatch || run.violationLatch;
      } catch {
        return false;
      }
    },
  };
}
