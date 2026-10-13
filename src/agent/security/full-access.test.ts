import { describe, expect, it } from "vitest";
import { fullAccessPresetAllowed } from "./full-access.ts";

describe("full-access preset host gate", () => {
  it("is off unless the host explicitly allows it", () => {
    expect(fullAccessPresetAllowed({})).toBe(false);
    expect(fullAccessPresetAllowed({ THEBE_FULL_ACCESS: "" })).toBe(false);
    expect(fullAccessPresetAllowed({ THEBE_FULL_ACCESS: "off" })).toBe(false);
    expect(fullAccessPresetAllowed({ THEBE_FULL_ACCESS: "no" })).toBe(false);
    expect(fullAccessPresetAllowed({ THEBE_FULL_ACCESS: "nonsense" })).toBe(
      false
    );
  });

  it("accepts the documented enabling values, case- and space-insensitively", () => {
    for (const value of ["on", "allow", "true", "1", "yes", " ON ", "True"]) {
      expect(fullAccessPresetAllowed({ THEBE_FULL_ACCESS: value })).toBe(true);
    }
  });
});
