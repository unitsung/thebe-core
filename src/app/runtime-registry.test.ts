import { describe, expect, it } from "vitest";
import {
  selectDeepSeekHarnessModel,
  selectRuntimeBootstrap,
  selectRuntimeName,
} from "./runtime-registry.ts";

describe("Agent runtime selection", () => {
  it("uses DeepSeek Harness by default", () => {
    expect(selectRuntimeName({})).toBe("dsh");
  });

  it("keeps Pi as an explicit compatibility runtime", () => {
    expect(selectRuntimeName({ THEBE_RUNTIME: " PI " })).toBe("pi");
  });

  it("fails closed on an unknown runtime name", () => {
    expect(() => selectRuntimeName({ THEBE_RUNTIME: "codex" })).toThrow(
      /THEBE_RUNTIME/
    );
  });

  it("does not let Pi provider credentials redirect the default DSH runtime", () => {
    expect(
      selectRuntimeBootstrap("dsh", undefined, {
        OPENAI_API_KEY: "openai-key",
        ANTHROPIC_API_KEY: "anthropic-key",
      })
    ).toEqual({});
  });

  it("keeps Pi provider defaults and their credential mapping", () => {
    expect(
      selectRuntimeBootstrap("pi", undefined, {
        OPENAI_API_KEY: "openai-key",
      })
    ).toEqual({
      model: { providerId: "openai", modelId: "gpt-4o" },
      primaryApiKey: { providerId: "openai", key: "openai-key" },
    });
  });

  it("uses the first configured DSH model when no explicit default exists", () => {
    expect(
      selectDeepSeekHarnessModel(undefined, {
        THEBE_DSH_MODELS: "deepseek-v4-pro, deepseek-flash",
      })
    ).toBe("deepseek-v4-pro");
  });

  it("preserves explicit DSH model precedence", () => {
    expect(
      selectDeepSeekHarnessModel("requested", {
        THEBE_DSH_MODEL: "configured",
        THEBE_DSH_MODELS: "listed",
      })
    ).toBe("requested");
    expect(
      selectDeepSeekHarnessModel(undefined, {
        THEBE_DSH_MODEL: "configured",
        THEBE_DSH_MODELS: "listed",
      })
    ).toBe("configured");
  });
});
