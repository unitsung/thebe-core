import type { NormalizedEvent, PromptInput } from "../../runtime/types.ts";
import { CONTAINER_TOOL_NAMES } from "../../tools/container-tools.ts";
import type { ThebePromptOptions, ThebePromptResult } from "../types.ts";
import type { ProductContext } from "./context.ts";

export function createPromptApi(ctx: ProductContext) {
  const {
    builtinTools,
    lastEvents,
    sessionLog,
    streaming,
    runPrompt,
    openSession,
  } = ctx;

  return {
    async prompt(
      input: string | PromptInput,
      promptOptions?: ThebePromptOptions,
    ): Promise<ThebePromptResult> {
      return runPrompt(input, promptOptions);
    },
    async send(
      text: string,
      thebeSessionId?: string,
    ): Promise<ThebePromptResult> {
      return runPrompt(text, { thebeSessionId });
    },
    toolNames(): string[] {
      return [...builtinTools, ...CONTAINER_TOOL_NAMES];
    },
    lastThebeSessionId(): string | undefined {
      return ctx.active?.meta.thebeSessionId;
    },
    lastEvents() {
      return lastEvents.slice();
    },
    events(thebeSessionId?: string): NormalizedEvent[] {
      const id = thebeSessionId ?? ctx.active?.meta.thebeSessionId;
      if (!id) {
        return [];
      }
      return sessionLog(id).events.slice();
    },
    subscribeLog(
      thebeSessionId: string,
      listener: (event: NormalizedEvent) => void,
    ): () => void {
      const log = sessionLog(thebeSessionId);
      log.listeners.add(listener);
      return () => {
        log.listeners.delete(listener);
      };
    },
    messages() {
      return ctx.active?.session.messages() ?? [];
    },
    async loadMessages(thebeSessionId: string) {
      const opened = await openSession(thebeSessionId);
      return opened.session.messages();
    },
    async message(thebeSessionId: string, messageId: string) {
      const opened = await openSession(thebeSessionId);
      return opened.session.messages().find((row) => row.id === messageId);
    },
    isStreaming(thebeSessionId: string): boolean {
      return streaming.has(thebeSessionId);
    },
  };
}
