import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduleApi } from "./service.ts";
import type { ThebeAgent } from "../interface.ts";
import type { GoalRun } from "../types.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const input = { title: "Health check", goal: "Check services without changing anything", startAt: "2026-10-06T01:00:00Z" };
function fixture(dir?: string) {
  let time = new Date("2026-10-06T01:00:00Z");
  let quiesced = false;
  const runs: GoalRun[] = [];
  const createSession = vi.fn(async () => ({ thebeSessionId: `session-${runs.length}`, runtimeId: "test", runtimeSessionId: "test", createdAt: time.toISOString(), updatedAt: time.toISOString() }));
  const startGoal = vi.fn(async (value: Parameters<ThebeAgent["startGoal"]>[0]) => {
    const run: GoalRun = { ...value, status: "running", iteration: 0, maxIterations: 1, subagentRunIds: [], createdAt: time.toISOString(), updatedAt: time.toISOString() };
    runs.push(run);
    return run;
  });
  const api = createScheduleApi({ dir, now: () => time, goals: { createSession, startGoal, listGoals: async () => runs }, isQuiesced: () => quiesced, checkWritable() { if (quiesced) throw new Error("quiesced"); } });
  return { api, runs, createSession, startGoal, time(value: string) { time = new Date(value); }, quiesce(value: boolean) { quiesced = value; } };
}

describe("durable Goal schedules", () => {
  it("dispatches one shot once even when ticks race, and preserves the normal Goal input", async () => {
    const f = fixture();
    const schedule = await f.api.createSchedule({ ...input, criteria: ["Use observations"], maxIterations: 3 });
    await Promise.all([f.api.tick(), f.api.tick()]);
    expect(f.startGoal).toHaveBeenCalledTimes(1);
    expect(f.startGoal).toHaveBeenCalledWith({ thebeSessionId: "session-0", goal: input.goal, criteria: ["Use observations"], maxIterations: 3 });
    expect(await f.api.getSchedule(schedule.id)).toMatchObject({ enabled: false, lastSessionId: "session-0", dispatching: false });
  });
  it("skips missed recurring occurrences and active/paused overlapping Goals", async () => {
    const f = fixture();
    const schedule = await f.api.createSchedule({ ...input, intervalMinutes: 60 });
    f.time("2026-10-06T05:30:00Z");
    await f.api.tick();
    expect((await f.api.getSchedule(schedule.id)).nextRunAt).toBe("2026-10-06T06:00:00.000Z");
    f.runs[0]!.status = "paused";
    f.time("2026-10-06T06:01:00Z");
    await f.api.tick();
    expect(f.startGoal).toHaveBeenCalledTimes(1);
    await expect(f.api.runSchedule(schedule.id)).rejects.toMatchObject({ status: 409 });
    expect((await f.api.getSchedule(schedule.id)).lastError).toContain("skipped");
  });
  it("persists edits and pause/resume/delete across recreation without replaying a completed occurrence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-schedules-")); dirs.push(dir);
    const f = fixture(dir);
    const schedule = await f.api.createSchedule(input);
    await f.api.tick();
    const restored = fixture(dir);
    await restored.api.tick();
    expect(restored.startGoal).not.toHaveBeenCalled();
    expect((await restored.api.listSchedules())[0]?.lastSessionId).toBe("session-0");
    await restored.api.updateSchedule(schedule.id, { ...input, title: "Edited", intervalMinutes: 5 });
    await restored.api.setScheduleEnabled(schedule.id, true);
    await restored.api.setScheduleEnabled(schedule.id, false);
    const again = fixture(dir);
    expect((await again.api.getSchedule(schedule.id)).title).toBe("Edited");
    await again.api.deleteSchedule(schedule.id);
    expect(await fixture(dir).api.listSchedules()).toEqual([]);
  });
  it("retains failed dispatch information, never retries the same occurrence, and respects maintenance", async () => {
    const f = fixture();
    const schedule = await f.api.createSchedule(input);
    f.quiesce(true); await f.api.tick(); expect(f.createSession).not.toHaveBeenCalled();
    f.quiesce(false); f.startGoal.mockRejectedValueOnce(new Error("provider unavailable"));
    await f.api.tick(); await f.api.tick();
    expect(f.startGoal).toHaveBeenCalledTimes(1);
    expect(await f.api.getSchedule(schedule.id)).toMatchObject({ lastError: "provider unavailable", lastSessionId: "session-0", enabled: false });
  });
  it("does not replay an interrupted durable reservation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-schedules-")); dirs.push(dir);
    const f = fixture(dir);
    const row = await f.api.createSchedule(input);
    await writeFile(join(dir, "schedules.json"), JSON.stringify([{ ...row, enabled: false, nextRunAt: undefined, dispatching: true, lastSessionId: "reserved" }]));
    const restored = fixture(dir); await restored.api.tick();
    expect(restored.startGoal).not.toHaveBeenCalled();
    expect(await restored.api.getSchedule(row.id)).toMatchObject({ dispatching: false, lastSessionId: "reserved", lastError: expect.stringContaining("restarted") });
  });
  it("rejects unbounded and invalid inputs before writing or running", async () => {
    const f = fixture();
    for (const patch of [{ intervalMinutes: 0 }, { maxIterations: 33 }, { startAt: "bad" }, { title: "" }, { criteria: [""] }]) {
      await expect(f.api.createSchedule({ ...input, ...patch })).rejects.toMatchObject({ status: 400 });
    }
    expect(await f.api.listSchedules()).toEqual([]);
  });
});
