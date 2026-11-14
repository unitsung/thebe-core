import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import {
  createQuietHoursStore,
  isQuiet,
  msUntilQuietEnds,
  parseQuietHours,
  QuietHoursError,
} from "./quiet-hours.ts";

const night = { start: "23:00", end: "07:00", timeZone: "UTC" };
const at = (hhmm: string) => new Date(`2026-11-06T${hhmm}:00Z`);

describe("quiet hours window", () => {
  it("runs past midnight when start is after end", () => {
    expect(isQuiet(night, at("23:00"))).toBe(true);
    expect(isQuiet(night, at("03:30"))).toBe(true);
    expect(isQuiet(night, at("06:59"))).toBe(true);
    expect(isQuiet(night, at("07:00"))).toBe(false);
    expect(isQuiet(night, at("12:00"))).toBe(false);
    expect(isQuiet(night, at("22:59"))).toBe(false);
  });

  it("handles a same-day window", () => {
    const nap = { start: "13:00", end: "14:30", timeZone: "UTC" };
    expect(isQuiet(nap, at("13:00"))).toBe(true);
    expect(isQuiet(nap, at("14:29"))).toBe(true);
    expect(isQuiet(nap, at("14:30"))).toBe(false);
  });

  it("reads the clock in the window's own zone", () => {
    // 16:00 UTC is 00:00 in Shanghai: quiet there, not in UTC.
    const shanghai = {
      start: "23:00",
      end: "07:00",
      timeZone: "Asia/Shanghai",
    };
    expect(isQuiet(shanghai, at("16:00"))).toBe(true);
    expect(isQuiet({ ...shanghai, timeZone: "UTC" }, at("16:00"))).toBe(false);
  });

  it("says how long until the window ends", () => {
    expect(msUntilQuietEnds(night, at("06:00"))).toBe(60 * 60_000);
    expect(msUntilQuietEnds(night, at("23:30"))).toBe(7.5 * 60 * 60_000);
    expect(msUntilQuietEnds(night, new Date("2026-11-06T06:59:30Z"))).toBe(
      30_000
    );
  });

  it("refuses what it cannot read instead of guessing", () => {
    expect(parseQuietHours(null)).toBeUndefined();
    expect(parseQuietHours({ start: "22:00", end: "06:30" })).toEqual({
      start: "22:00",
      end: "06:30",
    });
    for (const bad of [
      "night",
      [],
      { start: "24:00", end: "07:00" },
      { start: "7:00", end: "08:00" },
      { start: "23:00" },
      { start: "08:00", end: "08:00" },
      { start: "23:00", end: "07:00", timeZone: "Mars/Olympus" },
    ]) {
      expect(() => parseQuietHours(bad)).toThrow(QuietHoursError);
    }
  });

  it("keeps the window across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quiet-"));
    await createQuietHoursStore({ dir }).set(night);
    expect(await createQuietHoursStore({ dir }).get()).toEqual(night);
    await createQuietHoursStore({ dir }).set(null);
    expect(await createQuietHoursStore({ dir }).get()).toBeUndefined();
  });
});

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "ok",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
};

function open() {
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider,
  });
  const call = async (method: string, body?: unknown) => {
    const res = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/push/quiet-hours", {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { app, call };
}

describe("quiet hours route", () => {
  it("starts off, then saves, reads back and clears", async () => {
    const { call } = open();
    expect((await call("GET")).body).toEqual({ quietHours: null });
    const saved = await call("PUT", { quietHours: night });
    expect(saved.status).toBe(200);
    expect(saved.body.quietHours).toEqual(night);
    expect((await call("GET")).body.quietHours).toEqual(night);
    expect((await call("PUT", { quietHours: null })).body).toEqual({
      quietHours: null,
    });
    expect((await call("GET")).body).toEqual({ quietHours: null });
  });

  it("answers 400 for a window it cannot use and keeps the old one", async () => {
    const { call } = open();
    await call("PUT", { quietHours: night });
    const bad = await call("PUT", {
      quietHours: { start: "25:00", end: "07:00" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("invalid_quiet_hours");
    expect((await call("GET")).body.quietHours).toEqual(night);
  });

  it("is refused for a write while Core is quiesced, but can still be read", async () => {
    const { app, call } = open();
    await call("PUT", { quietHours: night });
    await app.agent.quiesce();
    expect((await call("PUT", { quietHours: null })).status).toBe(503);
    expect((await call("GET")).body.quietHours).toEqual(night);
  });

  it("only accepts GET and PUT", async () => {
    const { call } = open();
    expect((await call("DELETE")).status).toBe(405);
  });
});
