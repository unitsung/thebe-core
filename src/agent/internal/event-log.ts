import type { NormalizedEvent } from "../runtime/index.ts";

export type SessionLog = {
  events: NormalizedEvent[];
  listeners: Set<(event: NormalizedEvent) => void>;
};

/** Bounded event history shared by the conversation and control-plane seams. */
export function createEventLog(maxEvents = 5_000) {
  const lastEvents: NormalizedEvent[] = [];
  const logs = new Map<string, SessionLog>();

  function sessionLog(thebeSessionId: string): SessionLog {
    const existing = logs.get(thebeSessionId);
    if (existing) return existing;
    const created: SessionLog = { events: [], listeners: new Set() };
    logs.set(thebeSessionId, created);
    return created;
  }

  function appendEvent(thebeSessionId: string, event: NormalizedEvent): void {
    lastEvents.push(event);
    if (lastEvents.length > maxEvents) {
      lastEvents.splice(0, lastEvents.length - maxEvents);
    }
    const log = sessionLog(thebeSessionId);
    log.events.push(event);
    if (log.events.length > maxEvents) {
      log.events.splice(0, log.events.length - maxEvents);
    }
    for (const listener of log.listeners) listener(event);
  }

  function recentEvents(
    limit = 200,
  ): Array<NormalizedEvent & { thebeSessionId: string }> {
    const out: Array<NormalizedEvent & { thebeSessionId: string }> = [];
    for (const [thebeSessionId, log] of logs) {
      for (const event of log.events) out.push({ ...event, thebeSessionId });
    }
    return out.slice(-limit);
  }

  function removeSession(thebeSessionId: string): void {
    logs.delete(thebeSessionId);
  }

  return {
    lastEvents,
    logs,
    sessionLog,
    appendEvent,
    recentEvents,
    removeSession,
  };
}

export type EventLog = ReturnType<typeof createEventLog>;
