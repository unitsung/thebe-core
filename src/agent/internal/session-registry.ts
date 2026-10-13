import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../runtime/index.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { SessionState, OpenedSession } from "./session-state.ts";

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Owns active-session selection, runtime handles, resume, and idle reaping. */
export function createSessionRegistry(input: {
  runtime: AgentRuntime;
  state: SessionState;
  lookup(thebeSessionId: string): Promise<AgentSessionMeta>;
  persist(meta: AgentSessionMeta): Promise<void>;
  stamp(meta: AgentSessionMeta): AgentSessionMeta;
  createSessionOptions(
    explicitSessionId?: string,
    builtinTools?: readonly string[]
  ): Parameters<AgentRuntime["createSession"]>[0];
  cancelAutoSummary(thebeSessionId: string): void;
  removeEventLog(thebeSessionId: string): void;
  hasPending(thebeSessionId: string): boolean;
  idleTimeoutMs: number;
}) {
  let lastActiveId: string | undefined;
  let requestStop: () => void | Promise<void> = () => {};

  function getActive(): OpenedSession | undefined {
    return lastActiveId
      ? input.state.openedSessions.get(lastActiveId)
      : undefined;
  }

  function setActive(value: OpenedSession | undefined): void {
    if (!value) {
      lastActiveId = undefined;
      return;
    }
    input.state.openedSessions.set(value.meta.thebeSessionId, value);
    lastActiveId = value.meta.thebeSessionId;
    input.runtime.registerSessionLiveness?.(
      value.session.runtimeSessionId,
      () => input.state.openedSessions.has(value.meta.thebeSessionId)
    );
  }

  async function openSession(thebeSessionId?: string): Promise<OpenedSession> {
    if (thebeSessionId) {
      const cached = input.state.openedSessions.get(thebeSessionId);
      if (cached) {
        lastActiveId = thebeSessionId;
        if (cached.meta.leafId && cached.session.navigateTo) {
          await cached.session.navigateTo(cached.meta.leafId);
        }
        requestStop = () => cached.session.abort();
        return cached;
      }
      const meta = await input.lookup(thebeSessionId);
      const session = await input.runtime.resumeSession(
        meta.runtimeSessionId,
        input.createSessionOptions(meta.thebeSessionId, meta.builtinTools)
      );
      if (meta.leafId && session.navigateTo)
        await session.navigateTo(meta.leafId);
      requestStop = () => session.abort();
      const opened = { meta, session };
      setActive(opened);
      return opened;
    }
    const current = getActive();
    if (current) return current;
    const session = await input.runtime.createSession(
      input.createSessionOptions()
    );
    requestStop = () => session.abort();
    const meta = input.stamp({
      thebeSessionId: randomUUID(),
      runtimeId: input.runtime.runtimeId,
      runtimeSessionId: session.runtimeSessionId,
    });
    await input.persist(meta);
    const opened = { meta, session };
    setActive(opened);
    return opened;
  }

  async function reapIdleSessions(
    idleMs = input.idleTimeoutMs
  ): Promise<number> {
    if (idleMs <= 0) return 0;
    const cutoff = Date.now() - idleMs;
    let reaped = 0;
    for (const [id, opened] of input.state.openedSessions.entries()) {
      if (input.state.streaming.has(id) || input.hasPending(id)) continue;
      const last = Date.parse(opened.meta.lastActiveAt ?? "");
      if (!Number.isFinite(last) || last > cutoff) continue;
      opened.session.dispose();
      input.state.openedSessions.delete(id);
      input.cancelAutoSummary(id);
      input.removeEventLog(id);
      if (lastActiveId === id) lastActiveId = undefined;
      reaped += 1;
    }
    input.runtime.reapInactiveSessions?.();
    return reaped;
  }

  if (input.idleTimeoutMs > 0) {
    const interval = setInterval(
      () => void reapIdleSessions(),
      Math.min(input.idleTimeoutMs, 60_000)
    );
    interval.unref?.();
  }

  return {
    get active(): OpenedSession | undefined {
      return getActive();
    },
    set active(value: OpenedSession | undefined) {
      setActive(value);
    },
    get requestStop(): () => void | Promise<void> {
      return requestStop;
    },
    set requestStop(value: () => void | Promise<void>) {
      requestStop = value;
    },
    openSession,
    reapIdleSessions,
  };
}

export type SessionRegistry = ReturnType<typeof createSessionRegistry>;
