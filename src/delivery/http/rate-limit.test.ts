import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_RATE_LIMIT,
  createRateLimiter,
  mcpRateLimitFromEnv,
} from "./rate-limit.ts";

describe("createRateLimiter", () => {
  it("lets a caller through up to the limit, then says how long to wait", () => {
    let at = 0;
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => at,
    });
    expect(limiter.take("a")).toBeUndefined();
    expect(limiter.take("a")).toBeUndefined();
    at = 10_000;
    expect(limiter.take("a")).toBe(50);
    expect(limiter.take("b")).toBeUndefined();
    at = 60_000;
    expect(limiter.take("a")).toBeUndefined();
  });

  it("is off at 0", () => {
    const limiter = createRateLimiter({ limit: 0 });
    for (let i = 0; i < 500; i++) expect(limiter.take("a")).toBeUndefined();
  });
});

describe("mcpRateLimitFromEnv", () => {
  it("reads a whole number, 0 meaning off, and ignores anything else", () => {
    expect(mcpRateLimitFromEnv({})).toBe(DEFAULT_MCP_RATE_LIMIT);
    expect(mcpRateLimitFromEnv({ THEBE_MCP_RATE_LIMIT: "30" })).toBe(30);
    expect(mcpRateLimitFromEnv({ THEBE_MCP_RATE_LIMIT: "0" })).toBe(0);
    expect(mcpRateLimitFromEnv({ THEBE_MCP_RATE_LIMIT: "many" })).toBe(
      DEFAULT_MCP_RATE_LIMIT
    );
  });
});
