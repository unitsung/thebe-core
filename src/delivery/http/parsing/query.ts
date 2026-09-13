import type { ThinkingLevel } from "../../../agent/index.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && (THINKING_LEVELS as string[]).includes(value)
    ? value as ThinkingLevel : undefined;
}

const MAX_MESSAGE_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 200;

export function parseLimit(value: string | null):
  { ok: true; limit: number } | { ok: false; error: string } {
  if (value === null) return { ok: true, limit: DEFAULT_MESSAGE_LIMIT };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, error: "limit must be a positive integer" };
  return { ok: true, limit: Math.min(parsed, MAX_MESSAGE_LIMIT) };
}

export function parseLogCursor(request: Request, url: URL):
  { ok: true; after: number } | { ok: false; error: string } {
  const raw = url.searchParams.get("after") ?? request.headers.get("last-event-id");
  if (raw === null || raw === "") return { ok: true, after: 0 };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return { ok: false, error: "after must be a non-negative integer" };
  return { ok: true, after: parsed };
}
