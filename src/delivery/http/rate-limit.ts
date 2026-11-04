export type RateLimit = {
  /** Requests one key may make per window. */
  limit: number;
  windowMs: number;
};

export type RateLimiter = {
  readonly limit: RateLimit;
  /** Count one request for `key`: allowed, or refused with the whole seconds until its window ends. */
  take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
};

/**
 * A fixed window per key, counted in memory: a restart gives everyone a fresh window, which is
 * enough to stop a runaway or abusive client. A refused request is not counted again, so a client
 * that keeps retrying does not extend its own wait.
 */
export function createRateLimiter(
  limit: RateLimit,
  now: () => number = Date.now
): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    limit,
    take(key) {
      const at = now();
      if (windows.size > 1024) {
        for (const [k, w] of windows) {
          if (at - w.start >= limit.windowMs) windows.delete(k);
        }
      }
      let window = windows.get(key);
      if (!window || at - window.start >= limit.windowMs) {
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      if (window.count >= limit.limit) {
        return {
          ok: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((window.start + limit.windowMs - at) / 1000)
          ),
        };
      }
      window.count += 1;
      return { ok: true };
    },
  };
}
