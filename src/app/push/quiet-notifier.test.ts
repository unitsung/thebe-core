import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuietHoursStore } from "../../delivery/http/quiet-hours.ts";
import { createQuietHoursNotifier } from "./quiet-notifier.ts";
import type { DurablePushNotifier, PushNotice } from "./notifier.ts";

const night = { start: "23:00", end: "07:00", timeZone: "UTC" };
const notice = (id: string): PushNotice => ({
  category: "thebe.permission",
  title: "Thebe",
  body: "An action is waiting for your approval.",
  deepLink: `thebe://approval/${id}`,
  id,
});

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

async function setup(
  clock: { now: Date },
  options: { dir?: string; maxHeld?: number } = {}
) {
  const sent: string[] = [];
  const quiet = createQuietHoursStore({ dir: options.dir });
  await quiet.set(night);
  const inner: DurablePushNotifier = {
    notify: async (notice) => void sent.push(notice.id),
    flush: async () => undefined,
    status: () => ({ pending: 0, consecutiveFailures: 0, dropped: 0 }),
    close: () => undefined,
  };
  const notifier = createQuietHoursNotifier({
    inner,
    quiet,
    dir: options.dir,
    now: () => clock.now,
    maxHeld: options.maxHeld,
  });
  return { sent, quiet, notifier };
}

describe("quiet hours notifier", () => {
  it("sends at once outside the window", async () => {
    const { sent, notifier } = await setup({
      now: new Date("2026-11-06T12:00:00Z"),
    });
    await notifier.notify(notice("a"));
    expect(sent).toEqual(["a"]);
  });

  it("holds during the window and sends when it ends, once each", async () => {
    const clock = { now: new Date("2026-11-06T23:30:00Z") };
    const { sent, notifier } = await setup(clock);
    await notifier.notify(notice("a"));
    await notifier.notify(notice("b"));
    await notifier.notify(notice("a"));
    expect(sent).toEqual([]);
    clock.now = new Date("2026-11-07T07:00:00Z");
    await vi.advanceTimersByTimeAsync(7.5 * 60 * 60_000);
    expect(sent).toEqual(["b", "a"]);
    notifier.stop();
  });

  it("keeps only the newest when more are held than the cap", async () => {
    const clock = { now: new Date("2026-11-07T01:00:00Z") };
    const { sent, notifier } = await setup(clock, { maxHeld: 2 });
    for (const id of ["a", "b", "c"]) await notifier.notify(notice(id));
    clock.now = new Date("2026-11-07T07:00:00Z");
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(sent).toEqual(["b", "c"]);
    notifier.stop();
  });

  it("keeps holding when the window was moved later", async () => {
    const clock = { now: new Date("2026-11-07T01:00:00Z") };
    const { sent, quiet, notifier } = await setup(clock);
    await notifier.notify(notice("a"));
    await quiet.set({ start: "23:00", end: "09:00", timeZone: "UTC" });
    clock.now = new Date("2026-11-07T07:00:00Z");
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(sent).toEqual([]);
    clock.now = new Date("2026-11-07T09:00:00Z");
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(sent).toEqual(["a"]);
    notifier.stop();
  });

  it("survives a restart in the middle of the night", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quiet-held-"));
    const clock = { now: new Date("2026-11-07T01:00:00Z") };
    const first = await setup(clock, { dir });
    await first.notifier.notify(notice("a"));
    first.notifier.stop();

    const second = await setup(clock, { dir });
    await second.notifier.resume();
    expect(second.sent).toEqual([]);
    clock.now = new Date("2026-11-07T07:00:00Z");
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    // Sending rewrites the held file, which is real I/O the fake clock cannot wait for.
    await vi.waitFor(() => expect(second.sent).toEqual(["a"]));
    second.notifier.stop();
  });

  it("sends what was held at restart when the window is already over", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quiet-held-"));
    const clock = { now: new Date("2026-11-07T01:00:00Z") };
    const first = await setup(clock, { dir });
    await first.notifier.notify(notice("a"));
    first.notifier.stop();

    clock.now = new Date("2026-11-07T09:00:00Z");
    const second = await setup(clock, { dir });
    await second.notifier.resume();
    expect(second.sent).toEqual(["a"]);
    // And it is not sent a second time on the next start.
    const third = await setup(clock, { dir });
    await third.notifier.resume();
    expect(third.sent).toEqual([]);
  });
});
