import { describe, expect, it } from "vitest";
import { gate, isQuiet, parseGateSettings } from "./gate.ts";
import type { Trigger } from "./types.ts";

const trigger: Trigger = {
  id: "container-health:c1:unhealthy:1",
  source: "container-health",
  kind: "unhealthy",
  severity: "warning",
  thread: { kind: "container", id: "c1" },
  summary: "c1 turned unhealthy",
  observedAt: "2026-11-05T12:00:00.000Z",
};
const noon = new Date(2026, 10, 5, 12, 0);

describe("Gate", () => {
  it("filters a disabled source and an unwanted kind, in that order", () => {
    expect(gate(trigger, parseGateSettings({}), noon, [])).toEqual({
      result: "filtered",
      reason: "disabled",
    });
    expect(
      gate(
        trigger,
        parseGateSettings({ enabled: true, kinds: ["down"] }),
        noon,
        []
      )
    ).toEqual({ result: "filtered", reason: "kind" });
  });

  it("falls back to the default for a malformed setting instead of opening wider", () => {
    const settings = parseGateSettings({
      enabled: true,
      minSeverity: "loud",
      quietHours: { start: "late", end: "early" },
      dedupWindowMinutes: -5,
    });
    expect(settings).toMatchObject({
      minSeverity: "warning",
      quietHours: { start: "23:00", end: "08:00" },
      dedupWindowMs: 30 * 60_000,
    });
  });

  it("reads quiet hours that wrap past midnight", () => {
    const hours = { start: "23:00", end: "08:00" };
    expect(isQuiet(new Date(2026, 10, 5, 23, 0), hours)).toBe(true);
    expect(isQuiet(new Date(2026, 10, 5, 7, 59), hours)).toBe(true);
    expect(isQuiet(new Date(2026, 10, 5, 8, 0), hours)).toBe(false);
    expect(isQuiet(new Date(2026, 10, 5, 22, 59), hours)).toBe(false);
  });
});
