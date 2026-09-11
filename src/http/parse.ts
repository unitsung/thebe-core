import type { ThebeProduct } from "../product/service.ts";
import type {
  NormalizedEvent,
  PromptFile,
  PromptMode,
  ThinkingLevel,
} from "../runtime/types.ts";
import {
  estimatedDecodedBytes,
  isSupportedPromptFile,
  MAX_PROMPT_FILES,
  MAX_PROMPT_FILE_BYTES,
  MAX_INLINE_FILE_BYTES,
} from "../runtime/types.ts";
import { asObject, json, readJson } from "./json.ts";

export function parseMode(value: unknown): PromptMode | undefined {
  if (value === "steer" || value === "followUp" || value === "prompt") {
    return value;
  }
  return undefined;
}

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" &&
    (THINKING_LEVELS as string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 200;

export function parseLimit(
  value: string | null,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, limit: DEFAULT_MESSAGE_LIMIT };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, error: "limit must be a positive integer" };
  }
  return { ok: true, limit: Math.min(parsed, MAX_MESSAGE_LIMIT) };
}

/**
 * Log cursor is a log-index offset. Accepts `?after=` or the standard
 * `Last-Event-ID` header (SSE streams carry `id:` per event). Reconnect
 * strategy: resume the SSE with the last seen id, or refresh messages.
 */
export function parseLogCursor(
  request: Request,
  url: URL,
): { ok: true; after: number } | { ok: false; error: string } {
  const raw =
    url.searchParams.get("after") ?? request.headers.get("last-event-id");
  if (raw === null || raw === "") {
    return { ok: true, after: 0 };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, error: "after must be a non-negative integer" };
  }
  return { ok: true, after: parsed };
}

type ParsedPromptBody =
  | {
      ok: true;
      text: string;
      mode: PromptMode;
      files: PromptFile[];
      sessionId?: string;
    }
  | { ok: false; error: string; status?: number };

/** Shared prompt body validation for the session prompt route. */
export async function readPromptBody(request: Request): Promise<ParsedPromptBody> {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text : "";
  const mode = body.mode === undefined ? "prompt" : parseMode(body.mode);
  if (!mode) {
    return {
      ok: false,
      error: "invalid mode; want prompt, steer, or followUp",
    };
  }
  const filesResult = parsePromptFiles(body.files);
  if (!filesResult.ok) {
    return filesResult;
  }
  if (!text.trim() && filesResult.files.length === 0) {
    return { ok: false, error: "text or files required" };
  }
  const sessionId =
    typeof body.sessionId === "string"
      ? body.sessionId
      : typeof body.thebeSessionId === "string"
        ? body.thebeSessionId
        : undefined;
  return { ok: true, text, mode, files: filesResult.files, sessionId };
}

function parsePromptFiles(value: unknown): ParsedPromptBody {
  if (value === undefined) {
    return { ok: true, text: "", mode: "prompt", files: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "files must be an array" };
  }
  if (value.length > MAX_PROMPT_FILES) {
    return {
      ok: false,
      error: `too many files; maximum is ${MAX_PROMPT_FILES}`,
    };
  }
  const files: PromptFile[] = [];
  for (const item of value) {
    const row = asObject(item);
    const mediaType =
      typeof row.mediaType === "string" ? row.mediaType : "";
    if (!mediaType) {
      return { ok: false, error: "each file needs mediaType" };
    }
    if (!isSupportedPromptFile(mediaType)) {
      return { ok: false, error: `unsupported media type: ${mediaType}` };
    }
    const mode =
      row.mode === "reference" || row.mode === "lines" || row.mode === "inline"
        ? row.mode
        : "inline";
    const filename =
      typeof row.filename === "string" ? row.filename : undefined;
    const path = typeof row.path === "string" ? row.path : undefined;
    const data = typeof row.data === "string" ? row.data : undefined;
    const lineRange =
      row.lineRange && typeof row.lineRange === "object"
        ? {
            start:
              Number((row.lineRange as Record<string, unknown>).start) || 1,
            end: Number((row.lineRange as Record<string, unknown>).end) || 1,
          }
        : undefined;

    if (mode === "reference") {
      if (!path && !filename) {
        return {
          ok: false,
          error: "reference mode requires path or filename",
        };
      }
      files.push({ mode: "reference", mediaType, path, filename });
      continue;
    }

    if (mode === "lines") {
      if (!path && !filename) {
        return { ok: false, error: "lines mode requires path or filename" };
      }
      files.push({ mode: "lines", mediaType, path, filename, lineRange });
      continue;
    }

    // inline
    if (!data) {
      return { ok: false, error: "inline mode requires data" };
    }
    const decodedBytes = estimatedDecodedBytes(data);
    if (decodedBytes > MAX_PROMPT_FILE_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `file too large; maximum is ${MAX_PROMPT_FILE_BYTES} bytes decoded`,
      };
    }
    if (decodedBytes > MAX_INLINE_FILE_BYTES && (path || filename)) {
      files.push({ mode: "reference", mediaType, path, filename });
    } else {
      files.push({ mode: "inline", mediaType, data, filename, path });
    }
  }
  return { ok: true, text: "", mode: "prompt", files };
}

export function promptBodyError(result: { error: string; status?: number }): Response {
  return json({ error: result.error }, result.status ?? 400);
}

export function oauthCallbackInput(body: Record<string, unknown>): string | undefined {
  for (const key of ["url", "redirectUrl", "redirect_uri", "input"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return undefined;
  }
  const state = typeof body.state === "string" ? body.state.trim() : "";
  return state ? `${code}#${state}` : code;
}

export function productError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const statusHint =
    error instanceof Error
      ? (error as Error & { status?: unknown }).status
      : undefined;
  if (
    typeof statusHint === "number" &&
    Number.isInteger(statusHint) &&
    statusHint >= 400 &&
    statusHint < 600
  ) {
    return json({ ok: false, error: message }, statusHint);
  }
  const notFound =
    /unknown|no session|not found|ProductStore has no directory/i.test(
      message,
    );
  return json({ ok: false, error: message }, notFound ? 404 : 500);
}

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
  product: ThebeProduct,
  thebeSessionId: string,
  request: Request,
  after: number,
  options?: { idleMs?: number },
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
        }
      };
      for (const event of product.events(thebeSessionId).slice(after)) {
        send(event);
      }
      unsub = product.subscribeLog(thebeSessionId, send);
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
