import type { CreateThebeProductOptions } from "./context.ts";
import { createProductContext } from "./context.ts";
import { createControlApi } from "./control.ts";
import { createPromptApi } from "./prompt.ts";
import { createResourceApi } from "./resources.ts";
import { createSessionApi } from "./sessions.ts";

export type { CreateThebeProductOptions } from "./context.ts";
export {
  DEFAULT_AUTO_SUMMARY_DELAY_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
} from "./context.ts";
export {
  DEFAULT_MODEL_TEST_TIMEOUT_MS,
  httpError,
  type ThebePromptOptions,
  type ThebePromptResult,
  type ThebeReply,
  type SessionRunStatus,
  type SubagentRun,
  type SubagentRunStatus,
} from "../types.ts";
export type { PermissionMode } from "../../runtime/types.ts";

export function createThebeProduct(options: CreateThebeProductOptions) {
  const ctx = createProductContext(options);
  return {
    runtime: options.runtime,
    ...createPromptApi(ctx),
    ...createSessionApi(ctx),
    ...createResourceApi(ctx),
    ...createControlApi(ctx),
  };
}

export type ThebeProduct = ReturnType<typeof createThebeProduct>;
