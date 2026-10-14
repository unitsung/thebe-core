import { describe, expect, it } from "vitest";
import { resolveModelRef, modelKey, toRuntimeModel } from "./model-shape.ts";

describe("provider-scoped model availability", () => {
  const model = { provider: "configured", id: "shared-model" };

  it("marks an authenticated model available using registry keys", () => {
    expect(toRuntimeModel(model, new Set([modelKey(model)])).available).toBe(true);
  });

  it("does not borrow availability from another provider with the same model ID", () => {
    expect(toRuntimeModel(model, new Set(["other/shared-model"])).available).toBe(false);
  });

  it("uses exact service model IDs without inventing free-tier aliases", () => {
    const lookup = (provider: string, id: string) => provider === "opencode" && id === "actual" ? { provider, id } : undefined;
    expect(resolveModelRef(lookup, "opencode", "actual")?.id).toBe("actual");
    expect(resolveModelRef(lookup, "opencode", "muse-spark-1.3-free")).toBeUndefined();
  });
});

describe("placeholder limits", () => {
  it("reports Pi's default pair as unknown and leaves real sizes alone", async () => {
    const { withoutPlaceholderLimits } = await import("./model-shape.ts");
    expect(withoutPlaceholderLimits({ contextWindow: 128000, maxOutputTokens: 16384 })).toEqual({
      contextWindow: undefined, maxOutputTokens: undefined,
    });
    expect(withoutPlaceholderLimits({ contextWindow: 262144, maxOutputTokens: 32768 })).toEqual({
      contextWindow: 262144, maxOutputTokens: 32768,
    });
    expect(withoutPlaceholderLimits({ contextWindow: 128000, maxOutputTokens: 8192 })).toEqual({
      contextWindow: 128000, maxOutputTokens: 8192,
    });
  });
});
