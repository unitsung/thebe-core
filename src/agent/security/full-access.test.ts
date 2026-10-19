import { describe, expect, it } from "vitest";
import { fullAccessPresetAllowed } from "./full-access.ts";

describe("full-access preset", () => {
  it("is selectable whether or not THEBE_FULL_ACCESS is set", () => {
    expect(fullAccessPresetAllowed({})).toBe(true);
    for (const value of ["", "off", "no", "nonsense", "on", " ON ", "True"]) {
      expect(fullAccessPresetAllowed({ THEBE_FULL_ACCESS: value })).toBe(true);
    }
  });
});
