import { describe, expect, it } from "vitest";
import { isValidTimeZone, nextCronRun, parseCron } from "./cron.ts";

const next = (expr: string, zone: string, from: string) => {
  const at = nextCronRun(parseCron(expr), zone, Date.parse(from));
  return at === undefined ? undefined : new Date(at).toISOString();
};

describe("cron", () => {
  it("reads the fields in the owner's time zone", () => {
    // 09:00 in Shanghai is 01:00 UTC.
    expect(next("0 9 * * *", "Asia/Shanghai", "2026-10-16T00:00:00Z")).toBe(
      "2026-10-16T01:00:00.000Z"
    );
    expect(next("0 9 * * *", "Asia/Shanghai", "2026-10-16T01:00:01Z")).toBe(
      "2026-10-17T01:00:00.000Z"
    );
  });

  it("supports lists, ranges and steps", () => {
    expect(next("*/15 * * * *", "UTC", "2026-10-16T10:01:00Z")).toBe(
      "2026-10-16T10:15:00.000Z"
    );
    expect(next("0 9-17/4 * * *", "UTC", "2026-10-16T10:00:00Z")).toBe(
      "2026-10-16T13:00:00.000Z"
    );
    expect(next("30 8 * * 1-5", "UTC", "2026-10-16T09:00:00Z")).toBe(
      "2026-10-19T08:30:00.000Z"
    ); // Fri -> Mon
    expect(next("0 0 1,15 * *", "UTC", "2026-10-16T00:00:00Z")).toBe(
      "2026-11-01T00:00:00.000Z"
    );
  });

  it("matches a day by day-of-month or day-of-week when both are set, and treats 7 as Sunday", () => {
    // The 1st or any Monday: from Wed 2026-10-14, Monday the 19th comes before the 1st of November.
    expect(next("0 0 1 * 1", "UTC", "2026-10-14T00:00:00Z")).toBe(
      "2026-10-19T00:00:00.000Z"
    );
    expect(next("0 0 * * 7", "UTC", "2026-10-14T00:00:00Z")).toBe(
      "2026-10-18T00:00:00.000Z"
    );
  });

  it("keeps the wall-clock hour across daylight saving", () => {
    // New York leaves DST on 2026-11-01: 09:00 is 13:00 UTC before and 14:00 UTC after.
    expect(next("0 9 * * *", "America/New_York", "2026-10-31T00:00:00Z")).toBe(
      "2026-10-31T13:00:00.000Z"
    );
    expect(next("0 9 * * *", "America/New_York", "2026-11-01T00:00:00Z")).toBe(
      "2026-11-01T14:00:00.000Z"
    );
  });

  it("refuses what is not five valid fields", () => {
    for (const bad of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "*/0 * * * *",
      "a b c d e",
      "5-1 * * * *",
    ]) {
      expect(() => parseCron(bad), bad).toThrow();
    }
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });

  it("gives up on a date that never comes", () => {
    expect(next("0 0 31 2 *", "UTC", "2026-01-01T00:00:00Z")).toBeUndefined();
  });
});
