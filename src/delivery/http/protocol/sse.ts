import type { NormalizedEvent, ThebeAgent } from "../../../agent/index.ts";
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
