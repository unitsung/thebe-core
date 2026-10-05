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
