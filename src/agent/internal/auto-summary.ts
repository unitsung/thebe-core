import { createAuditLog, hashParameters } from "../../agent/security/audit/audit-log.ts";
import type { AgentRuntime, RuntimeModelRef, RuntimeSession } from "../runtime/index.ts";
import type { OpenedSession } from "./session-state.ts";
import {
  DEFAULT_AGENT_AUTO_SUMMARY_DELAY_MS,
  MAX_AGENT_AUTO_SUMMARY_DELAY_MS,
  MIN_AGENT_AUTO_SUMMARY_DELAY_MS,
} from "../settings/product.ts";

export const DEFAULT_AUTO_SUMMARY_DELAY_MS = DEFAULT_AGENT_AUTO_SUMMARY_DELAY_MS;

function normalizeDelay(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_SUMMARY_DELAY_MS;
  return Math.min(
    MAX_AGENT_AUTO_SUMMARY_DELAY_MS,
    Math.max(MIN_AGENT_AUTO_SUMMARY_DELAY_MS, Math.round(value as number)),
  );
}

export function summaryTranscript(
  messages: ReturnType<RuntimeSession["messages"]>,
): string {
  const rows: string[] = [];
  let remaining = 60_000;
  for (const message of [...messages].reverse()) {
    if (remaining <= 0) break;
    const role = message.role === "tool"
      ? `tool:${message.toolName ?? "unknown"}`
      : message.role;
    const text = message.text.trim();
    if (!text) continue;
    const clipped = text.slice(0, Math.min(text.length, remaining, 6_000));
    rows.push(`[${role}]\n${clipped}`);
    remaining -= clipped.length;
  }
  return rows.reverse().join("\n\n");
}

/** Schedules quiet-period summaries without making them part of the transcript. */
export function createAutoSummary(input: {
  runtime: AgentRuntime;
  model?: RuntimeModelRef;
  audit?: ReturnType<typeof createAuditLog>;
  now: () => Date;
  openedSessions: Map<string, OpenedSession>;
  streaming: Set<string>;
  promptLocks: Set<string>;
  persist(meta: OpenedSession["meta"]): Promise<void>;
  appendEvent(thebeSessionId: string, event: { type: "summary_ready"; summary: string; generatedAt: string }): void;
  enabled?: boolean;
  delayMs?: number;
}) {
  let enabledOverride = input.enabled;
  let delayOverride = normalizeDelay(input.delayMs);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const runs = new Set<string>();

  function enabled(): boolean { return enabledOverride ?? true; }
  function delayMs(): number { return delayOverride; }

  function cancel(thebeSessionId: string): void {
    const timer = timers.get(thebeSessionId);
    if (timer) clearTimeout(timer);
    timers.delete(thebeSessionId);
  }

  async function generate(thebeSessionId: string): Promise<void> {
    if (!enabled() || runs.has(thebeSessionId)) return;
    if (input.streaming.has(thebeSessionId) || input.promptLocks.has(thebeSessionId)) {
      schedule(thebeSessionId);
      return;
    }
    const opened = input.openedSessions.get(thebeSessionId);
    if (!opened) return;
    const messages = opened.session.messages();
    if (
      messages.filter((message) => message.role === "user").length === 0 ||
      messages.filter((message) => message.role === "assistant").length === 0
    ) return;
    const transcript = summaryTranscript(messages);
    if (!transcript) return;
    const activityAtStart = opened.meta.lastActiveAt;
    const messageCountAtStart = messages.length;
    runs.add(thebeSessionId);
    let summarySession: RuntimeSession | undefined;
    try {
      summarySession = await input.runtime.createSession({
        model: input.model,
        customTools: [],
        builtinTools: [],
        systemPrompt: "You are Thebe's background task summarizer. Do not perform actions or use tools. Summarize only what is evidenced in the transcript. Return concise Markdown in the same language as the user. Include: result, important files or changes, validation/tests, and remaining follow-ups. If there are no follow-ups, say so.",
        autoCompact: false,
        inMemory: true,
      });
      await summarySession.prompt(
        `Summarize this completed coding task:\n\n<conversation>\n${transcript}\n</conversation>`,
      );
      const summary = summarySession.lastAssistantText().trim();
      const current = input.openedSessions.get(thebeSessionId);
      if (
        !summary ||
        !current ||
        current.meta.lastActiveAt !== activityAtStart ||
        current.session.messages().length !== messageCountAtStart
      ) return;
      const generatedAt = input.now().toISOString();
      current.meta = { ...current.meta, lastSummary: summary, lastSummaryAt: generatedAt };
      await input.persist(current.meta);
      input.appendEvent(thebeSessionId, { type: "summary_ready", summary, generatedAt });
    } catch (error) {
      await input.audit?.append({
        method: "summary.auto",
        parameterHash: hashParameters({}),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
        sessionId: thebeSessionId,
        result: "error",
      }).catch(() => {});
      void error;
    } finally {
      summarySession?.dispose();
      runs.delete(thebeSessionId);
    }
  }

  function schedule(thebeSessionId: string): void {
    cancel(thebeSessionId);
    if (!enabled()) return;
    const timer = setTimeout(() => {
      timers.delete(thebeSessionId);
      void generate(thebeSessionId);
    }, delayMs());
    timer.unref?.();
    timers.set(thebeSessionId, timer);
  }

  function setEnabled(value: boolean): void {
    enabledOverride = value;
    if (!value) for (const id of timers.keys()) cancel(id);
  }

  function setDelayMs(value: number): void {
    delayOverride = normalizeDelay(value);
    for (const id of [...timers.keys()]) schedule(id);
  }

  return {
    enabled,
    delayMs,
    schedule,
    cancel,
    setEnabled,
    setDelayMs,
  };
}

export type AutoSummary = ReturnType<typeof createAutoSummary>;
