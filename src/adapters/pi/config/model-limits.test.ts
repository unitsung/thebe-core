import { describe, expect, it } from "vitest";
import { reportedLimits } from "./model-limits.ts";

describe("limits a service reports for a model", () => {
  it("reads the common shapes", () => {
    expect(reportedLimits({ id: "a", context_length: 131072, max_completion_tokens: 8192 })).toEqual({ contextWindow: 131072, maxTokens: 8192 });
    expect(reportedLimits({ id: "a", context_window: 200000, max_output_tokens: 32000 })).toEqual({ contextWindow: 200000, maxTokens: 32000 });
    expect(reportedLimits({ id: "a", max_model_len: 32768 })).toEqual({ contextWindow: 32768 });
    expect(reportedLimits({ name: "models/g", inputTokenLimit: 1048576, outputTokenLimit: 65536 })).toEqual({ contextWindow: 1048576, maxTokens: 65536 });
    expect(reportedLimits({ id: "a", limit: { context: 262144, output: 32768 } })).toEqual({ contextWindow: 262144, maxTokens: 32768 });
  });

  it("prefers the nested provider entry, as OpenRouter lists it", () => {
    expect(reportedLimits({
      id: "a", context_length: 1000000,
      top_provider: { context_length: 200000, max_completion_tokens: 16000 },
    })).toEqual({ contextWindow: 200000, maxTokens: 16000 });
  });

  it("reports nothing for a list that carries no sizes, and never invents a value", () => {
    expect(reportedLimits({ id: "big-pickle", object: "model", owned_by: "opencode" })).toEqual({});
    expect(reportedLimits("just-an-id")).toEqual({});
    expect(reportedLimits(null)).toEqual({});
  });

  it("ignores values that are not positive whole numbers and an output larger than the window", () => {
    expect(reportedLimits({ context_length: 0, max_tokens: -5 })).toEqual({});
    expect(reportedLimits({ context_length: "abc", max_tokens: "4096" })).toEqual({ maxTokens: 4096 });
    expect(reportedLimits({ context_length: 8000, max_completion_tokens: 64000 })).toEqual({ contextWindow: 8000 });
    expect(reportedLimits({ context_length: "65536" })).toEqual({ contextWindow: 65536 });
  });
});
