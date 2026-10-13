import type { AgentRuntime, RuntimeSession } from "../runtime/index.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { SessionRunStatus } from "../types.ts";

export type OpenedSession = {
  meta: AgentSessionMeta;
  session: RuntimeSession;
};

/**
 * Mutable agent-side state. Runtime transcript and branch data remain on
 * RuntimeSession; this module stores only metadata and lifecycle indexes.
 */
export function createSessionState(input: {
  runtime: AgentRuntime;
  now: () => Date;
  save(meta: AgentSessionMeta): Promise<void>;
  load(thebeSessionId: string): Promise<AgentSessionMeta>;
  listStored(): Promise<AgentSessionMeta[]>;
  hasPending(thebeSessionId: string): boolean;
}) {
  const memory = new Map<string, AgentSessionMeta>();
  const openedSessions = new Map<string, OpenedSession>();
  const streaming = new Set<string>();
  const abortRequested = new Set<string>();
  const promptLocks = new Set<string>();
  const nonInteractiveRuns = new Set<string>();

  function stamp(meta: AgentSessionMeta): AgentSessionMeta {
    const ts = input.now().toISOString();
    return { ...meta, createdAt: meta.createdAt ?? ts, lastActiveAt: ts };
  }

  function touchMeta(meta: AgentSessionMeta): AgentSessionMeta {
    const ts = input.now().toISOString();
    return {
      ...meta,
      createdAt: meta.createdAt ?? ts,
      updatedAt: ts,
      lastActiveAt: ts,
    };
  }

  async function persist(meta: AgentSessionMeta): Promise<void> {
    memory.set(meta.thebeSessionId, meta);
    await input.save(meta);
  }

  async function lookup(thebeSessionId: string): Promise<AgentSessionMeta> {
    const cached = memory.get(thebeSessionId);
    if (cached) return cached;
    const loaded = await input.load(thebeSessionId);
    memory.set(thebeSessionId, loaded);
    return loaded;
  }

  async function listMetas(): Promise<AgentSessionMeta[]> {
    const stored = await input.listStored();
    return stored.length > 0 ? stored : [...memory.values()];
  }

  function withRunState(
    meta: AgentSessionMeta
  ): AgentSessionMeta & { status: SessionRunStatus; streaming: boolean } {
    const isStreaming = streaming.has(meta.thebeSessionId);
    return {
      ...meta,
      streaming: isStreaming,
      status: !isStreaming
        ? "idle"
        : input.hasPending(meta.thebeSessionId)
          ? "awaiting_permission"
          : "running",
    };
  }

  return {
    memory,
    openedSessions,
    streaming,
    abortRequested,
    promptLocks,
    nonInteractiveRuns,
    stamp,
    touchMeta,
    persist,
    lookup,
    listMetas,
    withRunState,
  };
}

export type SessionState = ReturnType<typeof createSessionState>;
