import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationDigest } from "./digest.ts";
import type { Notification, NotificationTarget } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thebe-digest-"));
  dirs.push(dir);
  return dir;
}

const target: NotificationTarget = {
  id: "ops",
  channel: { source: "webhook", thread: "ops" },
  categories: "all",
  digest: { windowMinutes: 10, categories: ["pipeline", "budget"] },
  enabled: true,
};

function notice(
  id: string,
  overrides: Partial<Notification> = {}
): Notification {
  return {
    id,
    category: "pipeline",
    priority: "normal",
    title: `Run ${id}`,
    body: "The nightly run finished.",
    createdAt: "2026-11-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("notification digest", () => {
  it("accumulates low/normal notices and emits one summary when the window ends", async () => {
    let now = new Date("2026-11-14T10:00:00.000Z");
    const emitted: Notification[] = [];
    const digest = createNotificationDigest({
      now: () => now,
      emit: async (_target, notification) => {
        emitted.push(notification);
      },
    });
    expect(digest.canDigest(target, notice("one"))).toBe(true);
    expect(
      digest.canDigest(target, notice("critical", { priority: "critical" }))
    ).toBe(false);
    expect(await digest.add(target, notice("one"))).toBe(true);
    expect(await digest.add(target, notice("two"))).toBe(true);
    expect(await digest.pending()).toEqual([
      { targetId: "ops", count: 2, windowEndsAt: "2026-11-14T10:10:00.000Z" },
    ]);

    await digest.flushDue();
    expect(emitted).toEqual([]);

    now = new Date("2026-11-14T10:10:01.000Z");
    await digest.flushDue();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      category: "pipeline",
      priority: "normal",
      title: "Thebe: 2 updates",
    });
    expect(emitted[0]?.body).toContain("Run one");
    expect(emitted[0]?.body).toContain("Run two");
    expect(await digest.pending()).toEqual([]);
  });

  it("does not digest a critical notice or a category outside the window", async () => {
    const emitted: Notification[] = [];
    const digest = createNotificationDigest({
      now: () => new Date("2026-11-14T10:00:00.000Z"),
      emit: async (_target, notification) => {
        emitted.push(notification);
      },
    });
    expect(
      await digest.add(target, notice("critical", { priority: "critical" }))
    ).toBe(false);
    expect(
      await digest.add(target, notice("health", { category: "source_health" }))
    ).toBe(false);
    expect(await digest.pending()).toEqual([]);
  });

  it("keeps the window across a restart", async () => {
    const dir = await tempDir();
    let now = new Date("2026-11-14T10:00:00.000Z");
    const first = createNotificationDigest({
      dir,
      now: () => now,
      emit: async () => undefined,
    });
    await first.add(target, notice("one"));
    await first.stop();
    expect((await stat(join(dir, "digests.json"))).mode & 0o777).toBe(0o600);

    const emitted: Notification[] = [];
    now = new Date("2026-11-14T10:10:01.000Z");
    const restarted = createNotificationDigest({
      dir,
      now: () => now,
      emit: async (_target, notification) => {
        emitted.push(notification);
      },
    });
    expect(await restarted.pending()).toHaveLength(1);
    await restarted.flushDue();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.title).toBe("Thebe: 1 update");
    await restarted.stop();
  });

  it("accepts the same event twice without duplicating the summary count", async () => {
    const digest = createNotificationDigest({
      now: () => new Date("2026-11-14T10:00:00.000Z"),
      emit: async () => undefined,
    });
    await digest.add(target, notice("one"));
    expect(await digest.add(target, notice("one"))).toBe(true);
    expect(await digest.pending()).toMatchObject([{ count: 1 }]);
  });

  it("starts a new window after the previous one was emitted", async () => {
    let now = new Date("2026-11-14T10:00:00.000Z");
    const emitted: Notification[] = [];
    const digest = createNotificationDigest({
      now: () => now,
      emit: async (_target, notification) => {
        emitted.push(notification);
      },
    });
    await digest.add(target, notice("one"));
    now = new Date("2026-11-14T10:10:01.000Z");
    await digest.flushDue();
    await digest.add(target, notice("two"));
    expect(await digest.pending()).toMatchObject([{ count: 1 }]);
    now = new Date("2026-11-14T10:20:02.000Z");
    await digest.flushDue();
    expect(emitted.map((row) => row.title)).toEqual([
      "Thebe: 1 update",
      "Thebe: 1 update",
    ]);
  });
});
