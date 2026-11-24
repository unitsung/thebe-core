import {
  toProductWorker,
  type CapabilityRun,
  type NormalizedEvent,
  type ThebeAgent,
} from "../../../agent/index.ts";
import { json } from "../json.ts";
import type { TicketExecutionLog } from "../../../agent/tickets/log.ts";

export const SESSION_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_SESSION_LOG_STREAMS = 32;

let maxSessionLogStreams = MAX_SESSION_LOG_STREAMS;
let activeSessionLogStreams = 0;

export function resetSessionLogStreamsForTests(options?: {
  max?: number;
}): void {
  activeSessionLogStreams = 0;
  maxSessionLogStreams = options?.max ?? MAX_SESSION_LOG_STREAMS;
}

export function sessionLogStream(
  agent: ThebeAgent,
  thebeSessionId: string,
  request: Request,
  after: number,
  options?: { idleMs?: number; closeOnTerminal?: boolean }
): Response {
  if (activeSessionLogStreams >= maxSessionLogStreams) {
    return json({ ok: false, error: "too many log streams" }, 429);
  }
  activeSessionLogStreams += 1;
  const idleMs = options?.idleMs ?? SESSION_LOG_IDLE_MS;
  const encoder = new TextEncoder();
  let close: () => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let nextId = after;
      let closed = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let unsub: () => void = () => {};
      close = () => {
        if (closed) {
          return;
        }
        closed = true;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        unsub();
        activeSessionLogStreams = Math.max(0, activeSessionLogStreams - 1);
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const bumpIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        if (idleMs > 0) {
          idleTimer = setTimeout(close, idleMs);
        }
      };
      const send = (event: NormalizedEvent) => {
        if (closed) {
          return;
        }
        const line = `id: ${nextId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        nextId += 1;
        try {
          controller.enqueue(encoder.encode(line));
          bumpIdle();
        } catch {
          close();
          return;
        }
        if (
          options?.closeOnTerminal &&
          (event.type === "session_end" ||
            event.type === "error" ||
            event.type === "interrupted")
        ) {
          close();
        }
      };
      for (const event of agent.events(thebeSessionId).slice(after)) {
        send(event);
      }
      unsub = agent.subscribeLog(thebeSessionId, send);
      bumpIdle();
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export const TICKET_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_TICKET_LOG_STREAMS = 32;

let maxTicketLogStreams = MAX_TICKET_LOG_STREAMS;
let activeTicketLogStreams = 0;

export function resetTicketLogStreamsForTests(options?: {
  max?: number;
}): void {
  activeTicketLogStreams = 0;
  maxTicketLogStreams = options?.max ?? MAX_TICKET_LOG_STREAMS;
}

export function ticketEventStream(
  log: TicketExecutionLog,
  request: Request,
  after: number
): Response {
  if (activeTicketLogStreams >= maxTicketLogStreams) {
    return json({ ok: false, error: "too many log streams" }, 429);
  }
  activeTicketLogStreams += 1;
  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let cursor = after;
      let closed = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(idle);
        unsubscribe();
        request.signal.removeEventListener("abort", close);
        activeTicketLogStreams -= 1;
        try {
          controller.close();
        } catch {
          // A cancelled stream is already closed.
        }
      };
      const send = () => {
        if (closed) return;
        const page = log.read(cursor);
        for (const event of page.events) {
          controller.enqueue(
            encoder.encode(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
            )
          );
        }
        cursor = page.next;
        if (log.finished()) close();
        else {
          clearTimeout(idle);
          idle = setTimeout(close, TICKET_LOG_IDLE_MS);
        }
      };
      unsubscribe = log.subscribe(send);
      if (request.signal.aborted) close();
      else {
        request.signal.addEventListener("abort", close);
        send();
      }
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export const WORKER_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_WORKER_LOG_STREAMS = 32;

let maxWorkerLogStreams = MAX_WORKER_LOG_STREAMS;
let activeWorkerLogStreams = 0;

export function resetWorkerLogStreamsForTests(options?: {
  max?: number;
}): void {
  activeWorkerLogStreams = 0;
  maxWorkerLogStreams = options?.max ?? MAX_WORKER_LOG_STREAMS;
}

export function workerEventStream(
  agent: ThebeAgent,
  runId: string,
  request: Request,
  options?: { idleMs?: number }
): Response {
  if (activeWorkerLogStreams >= maxWorkerLogStreams) {
    return json({ ok: false, error: "too many log streams" }, 429);
  }
  const run = agent.getSubagent(runId);
  if (!run) {
    return json({ ok: false, error: "subagent not found" }, 404);
  }
  activeWorkerLogStreams += 1;
  const idleMs = options?.idleMs ?? WORKER_LOG_IDLE_MS;
  const encoder = new TextEncoder();
  let close: () => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let nextId = 0;
      let closed = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let unsub: () => void = () => {};
      close = () => {
        if (closed) return;
        closed = true;
        if (idleTimer) clearTimeout(idleTimer);
        unsub();
        activeWorkerLogStreams = Math.max(0, activeWorkerLogStreams - 1);
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleMs > 0) idleTimer = setTimeout(close, idleMs);
      };
      const send = (snapshot: Parameters<typeof toProductWorker>[0]) => {
        if (closed) return;
        const line = `id: ${nextId}\nevent: worker_update\ndata: ${JSON.stringify(toProductWorker(snapshot))}\n\n`;
        nextId += 1;
        try {
          controller.enqueue(encoder.encode(line));
          bumpIdle();
        } catch {
          close();
          return;
        }
        if (isTerminalWorkerStatus(snapshot.status)) close();
      };

      send(run);
      if (closed) return;
      unsub = agent.subscribeSubagent(runId, (update) => send(update.run));
      bumpIdle();
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function isTerminalWorkerStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

export const CAPABILITY_RUN_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_CAPABILITY_RUN_LOG_STREAMS = 32;

let maxCapabilityRunLogStreams = MAX_CAPABILITY_RUN_LOG_STREAMS;
let activeCapabilityRunLogStreams = 0;

export function resetCapabilityRunLogStreamsForTests(options?: {
  max?: number;
}): void {
  activeCapabilityRunLogStreams = 0;
  maxCapabilityRunLogStreams = options?.max ?? MAX_CAPABILITY_RUN_LOG_STREAMS;
}

export async function capabilityRunEventStream(
  agent: ThebeAgent,
  runId: string,
  request: Request,
  options?: { idleMs?: number }
): Promise<Response> {
  if (activeCapabilityRunLogStreams >= maxCapabilityRunLogStreams) {
    return json({ ok: false, error: "too many log streams" }, 429);
  }
  const run = await agent.getCapabilityRun(runId);
  if (!run) {
    return json({ ok: false, error: "capability run not found" }, 404);
  }
  activeCapabilityRunLogStreams += 1;
  const idleMs = options?.idleMs ?? CAPABILITY_RUN_LOG_IDLE_MS;
  const encoder = new TextEncoder();
  let close: () => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let nextId = 0;
      let closed = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let unsub: () => void = () => {};
      close = () => {
        if (closed) return;
        closed = true;
        if (idleTimer) clearTimeout(idleTimer);
        unsub();
        activeCapabilityRunLogStreams = Math.max(
          0,
          activeCapabilityRunLogStreams - 1
        );
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const bumpIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleMs > 0) idleTimer = setTimeout(close, idleMs);
      };
      const send = (snapshot: CapabilityRun) => {
        if (closed) return;
        const line = `id: ${nextId}\nevent: capability_update\ndata: ${JSON.stringify(snapshot)}\n\n`;
        nextId += 1;
        try {
          controller.enqueue(encoder.encode(line));
          bumpIdle();
        } catch {
          close();
          return;
        }
        if (isTerminalCapabilityRunStatus(snapshot.status)) close();
      };

      unsub = agent.subscribeCapabilityRun(runId, send);
      send(run);
      if (closed) return;
      if (request.signal.aborted) {
        close();
        return;
      }
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function isTerminalCapabilityRunStatus(status: string): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "interrupted"
  );
}
