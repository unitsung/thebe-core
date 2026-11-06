import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { key } from "./ids.ts";
import { createTicketStore } from "./store.ts";

const request = (n: number) => ({
  thread: `chat:s${n}`,
  triggerId: key("trigger", "chat", `s${n}`),
  kind: "goal-start",
  at: `2026-11-06T10:00:0${n}.000Z`,
  title: `task ${n}`,
  requester: "chat",
  goalId: `s${n}`,
  sessionIds: [`s${n}`],
});

describe("key", () => {
  it("is stable, 32 hex characters, and does not confuse where the parts split", () => {
    expect(key("a", "bc")).toBe(key("a", "bc"));
    expect(key("a", "bc")).toMatch(/^[a-f0-9]{32}$/);
    expect(key("a", "bc")).not.toBe(key("ab", "c"));
    expect(key("a")).not.toBe(key("a", ""));
  });
});

describe("ticket store", () => {
  it("gives the same Ticket for the same request, so a retry does not make a second", async () => {
    const store = createTicketStore({});
    const first = await store.recordDirect(request(1));
    const again = await store.recordDirect(request(1));
    expect(again.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
    expect(first.mandate).toMatchObject({
      strength: "explicit",
      decidedBy: "direct",
    });
    expect(first.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it("finds a Ticket by its Goal and lists newest first", async () => {
    const store = createTicketStore({});
    const a = await store.recordDirect(request(1));
    const b = await store.recordDirect(request(2));
    expect((await store.getByGoal("s2"))?.id).toBe(b.id);
    expect((await store.list()).map((t) => t.id)).toEqual([b.id, a.id]);
    expect(await store.getByGoal("nope")).toBeUndefined();
    expect(await store.get("../etc/passwd")).toBeUndefined();
  });

  it("survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-"));
    const first = await createTicketStore({ dir }).recordDirect(request(3));
    const reopened = createTicketStore({ dir });
    expect(await reopened.get(first.id)).toEqual(first);
    expect(await reopened.recordDirect(request(3))).toEqual(first);
    expect(await reopened.list()).toHaveLength(1);
  });

  it("keeps only the newest tickets within its bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-"));
    const store = createTicketStore({ dir, maxItems: 2 });
    await store.recordDirect(request(1));
    await store.recordDirect(request(2));
    await store.recordDirect(request(3));
    expect((await store.list()).map((t) => t.title)).toEqual([
      "task 3",
      "task 2",
    ]);
    expect(await createTicketStore({ dir }).list()).toHaveLength(2);
  });
});
