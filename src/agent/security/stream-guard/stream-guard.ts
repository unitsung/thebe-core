export type StreamGuardTimeoutKind = "ttfb_timeout" | "idle_timeout";

export type StreamGuardOptions = {
  /** Time-to-first-content-event. Default 300s. */
  ttfbMs?: number;
  /** Idle between content events after the first. Default 60s. */
  idleMs?: number;
  /** After abort(), mark force-killed if agent_end does not arrive. Default 10s. */
  watchdogMs?: number;
  abort?: () => void | Promise<void>;
  onEvent?: (kind: StreamGuardTimeoutKind | "force-killed") => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/**
 * Per-Run application timeouts over normalized runtime events.
 * Does not use fetch/undici or runtime timeout options.
 */
export function createStreamGuard(options: StreamGuardOptions = {}) {
  const ttfbMs = options.ttfbMs ?? 300_000;
  const idleMs = options.idleMs ?? 60_000;
  const watchdogMs = options.watchdogMs ?? 10_000;
  const setT = options.setTimeoutFn ?? setTimeout;
  const clearT = options.clearTimeoutFn ?? clearTimeout;
  let abortFn: (() => void | Promise<void>) | undefined = options.abort;
  const onEvent = options.onEvent;

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let ttfb: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let forceKilled = false;
  let firstContentSeen = false;
  let settled = false;

  function setAbort(fn: () => void | Promise<void>): void {
    abortFn = fn;
  }

  function clearWatchdog(): void {
    if (watchdog !== undefined) {
      clearT(watchdog);
      watchdog = undefined;
    }
  }

  function clearTimers(): void {
    if (ttfb !== undefined) {
      clearT(ttfb);
      ttfb = undefined;
    }
    if (idle !== undefined) {
      clearT(idle);
      idle = undefined;
    }
  }

  function notifyAgentEnd(): void {
    settled = true;
    clearTimers();
    clearWatchdog();
  }

  function dispose(): void {
    settled = true;
    clearTimers();
    clearWatchdog();
  }

  function beginRun(): void {
    clearTimers();
    clearWatchdog();
    forceKilled = false;
    firstContentSeen = false;
    settled = false;
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

  async function fireAbort(kind: StreamGuardTimeoutKind): Promise<void> {
    if (settled) {
      return;
    }
    onEvent?.(kind);
    try {
      await abortFn?.();
    } finally {
      armWatchdog();
    }
  }

  function noteAbort(): void {
    armWatchdog();
  }

  function resetIdle(): void {
    if (settled) {
      return;
    }
    if (idle !== undefined) {
      clearT(idle);
    }
    idle = setT(() => {
      void fireAbort("idle_timeout");
    }, idleMs);
  }

  function armTtfb(): void {
    if (settled) {
      return;
    }
    if (ttfb !== undefined) {
      clearT(ttfb);
    }
    ttfb = setT(() => {
      void fireAbort("ttfb_timeout");
    }, ttfbMs);
  }

  function noteContent(): void {
    if (settled) {
      return;
    }
    if (!firstContentSeen) {
      firstContentSeen = true;
      if (ttfb !== undefined) {
        clearT(ttfb);
        ttfb = undefined;
      }
      resetIdle();
      return;
    }
    resetIdle();
  }

  return {
    setAbort,
    notifyAgentEnd,
    noteAbort,
    noteContent,
    armTtfb,
    dispose,
    beginRun,
    wasForceKilled: () => forceKilled,
  };
}
