import { describe, expect, it } from "vitest";
import { selectRuntimeName } from "./runtime-registry.ts";

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
});
