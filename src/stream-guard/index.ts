import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failureMessage(
  model: { api: string; provider: string; id: string },
  stopReason: "aborted" | "error",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export type StreamGuardTimeoutKind = "ttfb_timeout" | "idle_timeout";

export type StreamGuardOptions = {
  /** Time-to-first-content-event. Default 300s. */
  ttfbMs?: number;
  /** Idle between content events after the first. Default 60s. */
  idleMs?: number;
  /** After abort(), mark force-killed if agent_end does not arrive. Default 10s. */
  watchdogMs?: number;
  abort?: () => void;
  onEvent?: (kind: StreamGuardTimeoutKind | "force-killed") => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

const CONTENT_DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

/**
 * Per-Run application timeouts. Does not use fetch/undici/runtime timeout options.
 * TTFB starts when streamFn is invoked and cancels on the first `start` event
 * (SSE keepalives are not protocol events). Idle resets on content deltas.
 * Pi 0.85 emits `toolcall_delta`; the spec's `tool_call_delta` is the old name.
 */
export function createStreamGuard(options: StreamGuardOptions = {}) {
  const ttfbMs = options.ttfbMs ?? 300_000;
  const idleMs = options.idleMs ?? 60_000;
  const watchdogMs = options.watchdogMs ?? 10_000;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;
  let abortFn: (() => void) | undefined = options.abort;
  const onEvent = options.onEvent;

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let forceKilled = false;

  function setAbort(fn: () => void): void {
    abortFn = fn;
  }

  function clearWatchdog(): void {
    if (watchdog !== undefined) {
      clearT(watchdog);
      watchdog = undefined;
    }
  }

  function notifyAgentEnd(): void {
    clearWatchdog();
  }

  function dispose(): void {
    clearWatchdog();
  }

  function beginRun(): void {
    clearWatchdog();
    forceKilled = false;
  }

  function armWatchdog(): void {
    if (watchdog !== undefined) {
      return;
    }
    watchdog = setT(() => {
      watchdog = undefined;
      forceKilled = true;
      onEvent?.("force-killed");
    }, watchdogMs);
    const t = watchdog as unknown as { unref?: () => void };
    if (typeof t.unref === "function") {
      t.unref();
    }
  }

  function fireAbort(kind: StreamGuardTimeoutKind): void {
    onEvent?.(kind);
    try {
      abortFn?.();
    } finally {
      // abort() is best-effort; force-killed if agent_end never arrives.
      armWatchdog();
    }
  }

  function noteAbort(): void {
    armWatchdog();
  }

  function wrapStreamFn(inner: StreamFn): StreamFn {
    return ((model, context, streamOptions) => {
      const outer = createAssistantMessageEventStream();
      let ttfb: ReturnType<typeof setTimeout> | undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const clearTimers = () => {
        if (ttfb !== undefined) {
          clearT(ttfb);
          ttfb = undefined;
        }
        if (idle !== undefined) {
          clearT(idle);
          idle = undefined;
        }
      };

      const completeOuter = (
        stopReason: "aborted" | "error",
        errorMessage: string,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        const msg = failureMessage(model, stopReason, errorMessage);
        try {
          outer.push({ type: "error", reason: stopReason, error: msg });
        } catch {
          // already complete
        }
        try {
          outer.end(msg);
        } catch {
          // ignore
        }
      };

      const resetIdle = () => {
        if (settled) {
          return;
        }
        if (idle !== undefined) {
          clearT(idle);
        }
        idle = setT(() => {
          completeOuter("aborted", "idle_timeout");
          fireAbort("idle_timeout");
        }, idleMs);
      };

      ttfb = setT(() => {
        completeOuter("aborted", "ttfb_timeout");
        fireAbort("ttfb_timeout");
      }, ttfbMs);

      const signal = streamOptions?.signal;
      const onSignalAbort = () => {
        noteAbort();
        completeOuter("aborted", "aborted");
      };
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      if (signal?.aborted) {
        onSignalAbort();
      }

      void (async () => {
        try {
          const innerStream = await inner(model, context, streamOptions);
          if (settled) {
            return;
          }
          let firstContentSeen = false;
          for await (const event of innerStream) {
            if (settled) {
              break;
            }
            const type = (event as { type?: string }).type;
            if (!firstContentSeen && type === "start") {
              firstContentSeen = true;
              if (ttfb !== undefined) {
                clearT(ttfb);
                ttfb = undefined;
              }
              resetIdle();
            } else if (
              firstContentSeen &&
              type !== undefined &&
              CONTENT_DELTAS.has(type)
            ) {
              resetIdle();
            } else if (
              !firstContentSeen &&
              type !== undefined &&
              (CONTENT_DELTAS.has(type) ||
                type === "text_start" ||
                type === "thinking_start" ||
                type === "toolcall_start" ||
                type === "tool_call_delta")
            ) {
              firstContentSeen = true;
              if (ttfb !== undefined) {
                clearT(ttfb);
                ttfb = undefined;
              }
              resetIdle();
            }
            outer.push(event);
            if (type === "done" || type === "error") {
              settled = true;
              clearTimers();
              break;
            }
          }
        } catch (error) {
          completeOuter(
            "error",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          signal?.removeEventListener("abort", onSignalAbort);
          clearTimers();
          if (!settled) {
            settled = true;
            try {
              const result = await outer.result().catch(() => undefined);
              outer.end(result);
            } catch {
              try {
                outer.end(undefined);
              } catch {
                // ignore
              }
            }
          }
        }
      })();
      return outer;
    }) as StreamFn;
  }

  return {
    setAbort,
    wrapStreamFn,
    notifyAgentEnd,
    noteAbort,
    dispose,
    beginRun,
    wasForceKilled: () => forceKilled,
  };
}
