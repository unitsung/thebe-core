import {
  isTerminalGoalStatus,
  toProductWorker,
  toProductGoalEvent,
  type GoalEvent,
  type NormalizedEvent,
  type ThebeAgent,
} from "../../../agent/index.ts";
import { json } from "../json.ts";

export const SESSION_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_SESSION_LOG_STREAMS = 32;

let maxSessionLogStreams = MAX_SESSION_LOG_STREAMS;
let activeSessionLogStreams = 0;

export function resetSessionLogStreamsForTests(options?: { max?: number }): void {
  activeSessionLogStreams = 0;
  maxSessionLogStreams = options?.max ?? MAX_SESSION_LOG_STREAMS;
}

export function sessionLogStream(
  agent: ThebeAgent,
  thebeSessionId: string,
  request: Request,
  after: number,
  options?: { idleMs?: number; closeOnTerminal?: boolean },
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
        const line =
          `id: ${nextId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
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

export const GOAL_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_GOAL_LOG_STREAMS = 32;

let maxGoalLogStreams = MAX_GOAL_LOG_STREAMS;
let activeGoalLogStreams = 0;

export function resetGoalLogStreamsForTests(options?: { max?: number }): void {
  activeGoalLogStreams = 0;
  maxGoalLogStreams = options?.max ?? MAX_GOAL_LOG_STREAMS;
}

export function goalEventStream(
  agent: ThebeAgent,
  thebeSessionId: string,
  request: Request,
  after: number,
  options?: { idleMs?: number },
): Response {
  if (activeGoalLogStreams >= maxGoalLogStreams) {
    return json({ ok: false, error: "too many log streams" }, 429);
  }
  const run = agent.getGoal(thebeSessionId);
  if (!run) {
    return json({ ok: false, error: "goal not found" }, 404);
  }
  activeGoalLogStreams += 1;
  const idleMs = options?.idleMs ?? GOAL_LOG_IDLE_MS;
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
        activeGoalLogStreams = Math.max(0, activeGoalLogStreams - 1);
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
      const send = (event: GoalEvent, at: string) => {
        if (closed) {
          return;
        }
        const product = toProductGoalEvent(thebeSessionId, event, nextId, at);
        const line =
          `id: ${nextId}\nevent: ${product.type}\ndata: ${JSON.stringify(product)}\n\n`;
        nextId += 1;
        try {
          controller.enqueue(encoder.encode(line));
          bumpIdle();
        } catch {
          close();
          return;
        }
        if (event.type === "goal_completed") {
          close();
        }
      };
      const buffered = agent.goalEvents(thebeSessionId).slice(after);
      for (const row of buffered) {
        send(row.event, row.at);
      }
      if (buffered.length === 0) {
        const snapshot = agent.getGoal(thebeSessionId);
        if (snapshot && isTerminalGoalStatus(snapshot.status)) {
          send(
            {
              type: "goal_completed",
              status: snapshot.status,
              totalIterations: snapshot.iteration,
              summary: snapshot.summary ?? snapshot.error ?? `Goal ${snapshot.status}.`,
            },
            snapshot.finishedAt ?? snapshot.createdAt,
          );
        } else if (snapshot) {
          send(
            {
              type: "goal_status",
              status:
                snapshot.status === "pausing"
                  ? "pausing"
                  : snapshot.status === "paused"
                    ? "paused"
                    : "running",
              message: snapshot.summary,
            },
            snapshot.finishedAt ?? snapshot.createdAt,
          );
        }
      }
      const current = agent.getGoal(thebeSessionId);
      if (current && isTerminalGoalStatus(current.status)) {
        close();
        return;
      }
      unsub = agent.subscribeGoal(thebeSessionId, (event) => {
        send(event, new Date().toISOString());
      });
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

export const WORKER_LOG_IDLE_MS = 5 * 60 * 1000;
export const MAX_WORKER_LOG_STREAMS = 32;

let maxWorkerLogStreams = MAX_WORKER_LOG_STREAMS;
let activeWorkerLogStreams = 0;

export function resetWorkerLogStreamsForTests(options?: { max?: number }): void {
  activeWorkerLogStreams = 0;
  maxWorkerLogStreams = options?.max ?? MAX_WORKER_LOG_STREAMS;
}

export function workerEventStream(
  agent: ThebeAgent,
  runId: string,
  request: Request,
  options?: { idleMs?: number },
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
        const line =
          `id: ${nextId}\nevent: worker_update\ndata: ${JSON.stringify(toProductWorker(snapshot))}\n\n`;
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
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}
