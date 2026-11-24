/**
 * A fixed-window counter per caller. A caller over the limit is refused at once with how long to
 * wait; nothing is queued, in keeping with "a call either runs or fails where you can see it".
 */
export type RateLimiter = {
  /** `undefined` when the call may go ahead, else the seconds until the window resets. */
  take(key: string): number | undefined;
};

export const MCP_RATE_LIMIT_ENV = "THEBE_MCP_RATE_LIMIT";
/** Calls a minute for an external agent (a scoped token). Full-access tokens are not limited. */
export const DEFAULT_MCP_RATE_LIMIT = 120;

export function createRateLimiter(options: {
  limit: number;
  windowMs?: number;
  now?: () => number;
}): RateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    take(key) {
      if (options.limit <= 0) return undefined;
      const at = now();
      let window = windows.get(key);
      if (!window || at - window.start >= windowMs) {
        window = { start: at, count: 0 };
        windows.set(key, window);
        // A long-running Core sees few distinct callers, but do not let the map grow without bound.
        if (windows.size > 1024) {
          for (const [name, other] of windows) {
            if (at - other.start >= windowMs) windows.delete(name);
          }
        }
      }
      if (window.count >= options.limit) {
        return Math.max(1, Math.ceil((window.start + windowMs - at) / 1000));
      }
      window.count += 1;
      return undefined;
    },
  };
}

/** The per-minute limit: the env value when it is a whole number (0 turns it off), else the default. */
export function mcpRateLimitFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[MCP_RATE_LIMIT_ENV]?.trim();
  if (!raw) return DEFAULT_MCP_RATE_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MCP_RATE_LIMIT;
}
