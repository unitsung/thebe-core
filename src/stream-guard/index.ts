import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

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

  function fireAbort(kind: StreamGuardTimeoutKind): void {
    onEvent?.(kind);
    try {
      abortFn?.();
    } finally {
      // abort() is best-effort; force-killed if agent_end never arrives.
      clearWatchdog();
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
  }

  function wrapStreamFn(inner: StreamFn): StreamFn {
    return ((model, context, streamOptions) => {
      const outer = createAssistantMessageEventStream();
      void (async () => {
        let ttfb: ReturnType<typeof setTimeout> | undefined;
        let idle: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const clearAll = () => {
          settled = true;
          if (ttfb !== undefined) {
            clearT(ttfb);
            ttfb = undefined;
          }
          if (idle !== undefined) {
            clearT(idle);
            idle = undefined;
          }
        };
        const resetIdle = () => {
          if (settled) return;
          if (idle !== undefined) clearT(idle);
          idle = setT(() => {
            clearAll();
            fireAbort("idle_timeout");
          }, idleMs);
        };
        ttfb = setT(() => {
          clearAll();
          fireAbort("ttfb_timeout");
        }, ttfbMs);

        try {
          const innerStream = await inner(model, context, streamOptions);
          let firstContentSeen = false;
          for await (const event of innerStream) {
            const type = (event as { type?: string }).type;
            if (!firstContentSeen && type === "start") {
              firstContentSeen = true;
              if (ttfb !== undefined) {
                clearT(ttfb);
                ttfb = undefined;
              }
              resetIdle();
            } else if (firstContentSeen && type !== undefined && CONTENT_DELTAS.has(type)) {
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
              clearAll();
              break;
            }
          }
        } catch (error) {
          clearAll();
          outer.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              stopReason: "error",
              errorMessage:
                error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
            },
          } as never);
        } finally {
          clearAll();
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
      })();
      return outer;
    }) as StreamFn;
  }

  return {
    setAbort,
    wrapStreamFn,
    notifyAgentEnd,
    dispose,
    beginRun,
    wasForceKilled: () => forceKilled,
  };
}
