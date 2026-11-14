import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNotificationOutbox } from "./outbox.ts";
import type { Notification } from "./types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thebe-notifications-"));
  dirs.push(dir);
  return dir;
}

const target = {
  target: {
    id: "ops",
    channel: {
      source: "webhook",
      thread: "ops",
      address: { url: "https://example.test/hook" },
    },
    categories: "all" as const,
    enabled: true,
  },
};

function notice(id: string): Notification {
  return {
    id,
    category: "attention",
    priority: "critical",
    title: "Thebe",
    body: "Something needs you.",
    createdAt: "2026-11-14T10:00:00.000Z",
  };
}

describe("notification outbox", () => {
  it("delivers one notice per target in order and deduplicates the same event", async () => {
    let now = new Date("2026-11-14T10:00:00.000Z");
    const sent: string[] = [];
    const outbox = createNotificationOutbox({
      now: () => now,
      send: async (input) => {
        sent.push(input.notification.id);
        return { status: "sent" };
      },
    });

    await outbox.enqueue([{ ...target, notification: notice("one") }]);
    await outbox.enqueue([{ ...target, notification: notice("one") }]);
    await outbox.enqueue([{ ...target, notification: notice("two") }]);
    expect(await outbox.pending()).toHaveLength(2);

    await outbox.flush();
    expect(sent).toEqual(["one", "two"]);
    expect((await outbox.pending()).length).toBe(0);
  });

  it("keeps the same idempotency key across retries and waits for the back-off", async () => {
    let now = new Date("2026-11-14T10:00:00.000Z");
    const keys: string[] = [];
    let fail = true;
    const outbox = createNotificationOutbox({
      now: () => now,
      retryBaseMs: 1_000,
      send: async (input) => {
        keys.push(input.idempotencyKey);
        return fail
          ? { status: "retry", reason: "provider_busy" }
          : { status: "sent" };
      },
    });
    await outbox.enqueue([{ ...target, notification: notice("one") }]);

    await outbox.flush();
    expect(keys).toHaveLength(1);
    await outbox.flush();
    expect(keys).toHaveLength(1);
    expect(outbox.status().lastError).toContain("provider_busy");

    fail = false;
    now = new Date(now.getTime() + 2_000);
    await outbox.flush();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect((await outbox.pending()).length).toBe(0);
  });

  it("settles an interrupted send as unknown after a restart and never replays it", async () => {
    const dir = await tempDir();
    let now = new Date("2026-11-14T10:00:00.000Z");
    const sent: string[] = [];
    const first = createNotificationOutbox({
      dir,
      now: () => now,
      send: async () => {
        throw new Error("not used");
      },
    });
    await first.enqueue([{ ...target, notification: notice("one") }]);
    await first.stop();

    // Simulate the process dying after the adapter was called but before the result was stored.
    const file = join(dir, "outbox.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    stored.entries[0]!.state = "send_started";
    stored.entries[0]!.attemptId = "attempt-1";
    stored.entries[0]!.leaseUntil = "2026-11-14T10:01:00.000Z";
    await writeFile(file, `${JSON.stringify(stored)}\n`, "utf8");

    const restarted = createNotificationOutbox({
      dir,
      now: () => now,
      send: async (input) => {
        sent.push(input.notification.id);
        return { status: "sent" };
      },
    });
    expect(await restarted.pending()).toEqual([]);
    await restarted.flush();
    expect(sent).toEqual([]);
    const status = restarted.status();
    expect(status.unknown).toBe(1);
    expect(status.pending).toBe(0);
  });

  it("stores a notice that may have been sent as unknown instead of retrying it", async () => {
    const outbox = createNotificationOutbox({
      send: async () => ({ status: "unknown", reason: "request timed out" }),
    });
    await outbox.enqueue([{ ...target, notification: notice("one") }]);
    await outbox.flush();
    await outbox.flush();
    expect((await outbox.pending()).length).toBe(0);
    expect(outbox.status()).toMatchObject({ pending: 0, unknown: 1 });
  });

  it("survives a restart with the same pending entry", async () => {
    const dir = await tempDir();
    let now = new Date("2026-11-14T10:00:00.000Z");
    const first = createNotificationOutbox({
      dir,
      now: () => now,
      send: async () => ({ status: "retry", reason: "unavailable" }),
    });
    await first.enqueue([{ ...target, notification: notice("one") }]);
    await first.flush();
    await first.stop();

    now = new Date(now.getTime() + 60_000);
    const sent: string[] = [];
    const restarted = createNotificationOutbox({
      dir,
      now: () => now,
      send: async (input) => {
        sent.push(input.notification.id);
        return { status: "sent" };
      },
    });
    expect(await restarted.pending()).toHaveLength(1);
    await restarted.flush();
    expect(sent).toEqual(["one"]);
    await restarted.stop();
  });

  it("upgrades an entry written before the target was stored with the entry", async () => {
    const dir = await tempDir();
    const first = createNotificationOutbox({
      dir,
      send: async () => ({ status: "sent" }),
    });
    await first.enqueue([{ ...target, notification: notice("one") }]);
    await first.stop();
    const file = join(dir, "outbox.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    delete stored.entries[0]!.target;
    await writeFile(file, `${JSON.stringify(stored)}\n`, "utf8");

    const sent: string[] = [];
    const restarted = createNotificationOutbox({
      dir,
      send: async (input) => {
        sent.push(input.target.id);
        return { status: "sent" };
      },
    });
    expect(await restarted.pending()).toHaveLength(1);
    await restarted.flush();
    expect(sent).toEqual(["ops"]);
  });

  it("writes the outbox to disk so a restart sees it", async () => {
    const dir = await tempDir();
    const outbox = createNotificationOutbox({
      dir,
      send: async () => ({ status: "sent" }),
    });
    await outbox.enqueue([{ ...target, notification: notice("one") }]);
    const state = JSON.parse(await readFile(join(dir, "outbox.json"), "utf8"));
    expect(state.entries).toHaveLength(1);
    await outbox.stop();
    await mkdir(dir, { recursive: true });
  });
});
