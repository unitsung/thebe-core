import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Trigger } from "../sources/types.ts";
import { createResidentMainSession } from "./resident.ts";

const START = "2026-11-10T00:00:00.000Z";

function trigger(n: number, thread = `resource:container:c${n}`): Trigger {
  return {
    id: String(n).repeat(32),
    source: "container-health",
    kind: "container.went_down",
    at: START,
    threads: [thread],
    resource: { kind: "container", id: `c${n}` },
    payload: { name: `c${n}`, state: "exited" },
  };
}

async function setup(
  overrides: {
    dir?: string;
    exhausted?: boolean;
    prompt?: (input: string) => Promise<unknown>;
    openTickets?: number;
    abort?: () => void | Promise<void>;
  } = {}
) {
  const rows = new Map<string, Trigger>();
  const prompts: string[] = [];
  let exhausted = overrides.exhausted ?? false;
  const resident = createResidentMainSession({
    dir: overrides.dir,
    triggers: {
      async get(id) {
        return rows.get(id);
      },
    },
    tickets: {
      async list() {
        return Array.from(
          { length: overrides.openTickets ?? 0 },
          (_, index) => ({
            ticket: { id: `${index}`.padStart(32, "0") },
            stage: "attention",
          })
        ) as never[];
      },
    },
    async getMainSession() {
      return { initialized: true } as never;
    },
    async prompt(input) {
      prompts.push(input);
      await overrides.prompt?.(input);
    },
    budget: {
      async exhausted() {
        return exhausted;
      },
    },
    abort: overrides.abort,
    batchWindowMs: 10,
    retryMs: 10,
  });
  resident.start();
  return {
    resident,
    rows,
    prompts,
    setExhausted(value: boolean) {
      exhausted = value;
    },
  };
}

describe("resident main Session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges events queued together into one model turn and never delivers them twice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-resident-"));
    const first = await setup({ dir });
    const one = trigger(1);
    const two = trigger(2);
    first.rows.set(one.id, one);
    first.rows.set(two.id, two);

    await first.resident.enqueue([one]);
    await first.resident.enqueue([two]);
    await first.resident.pollOnce();

    expect(first.prompts).toHaveLength(1);
    expect(first.prompts[0]).toContain(one.id);
    expect(first.prompts[0]).toContain(two.id);
    await first.resident.stop();

    const second = await setup({ dir });
    second.rows.set(one.id, one);
    second.rows.set(two.id, two);
    await second.resident.enqueue([one, two]);
    await second.resident.pollOnce();
    expect(second.prompts).toEqual([]);
    await second.resident.stop();
  });

  it("keeps a failed batch pending across restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-resident-retry-"));
    const first = await setup({
      dir,
      prompt: async () => {
        throw new Error("provider unavailable");
      },
    });
    const row = trigger(3);
    first.rows.set(row.id, row);
    await first.resident.enqueue([row]);
    await first.resident.pollOnce();
    expect(first.prompts).toHaveLength(1);
    await first.resident.stop();

    const second = await setup({ dir });
    second.rows.set(row.id, row);
    await second.resident.pollOnce();
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain(row.id);
    await second.resident.stop();
  });

  it("picks up open Tickets after restart without inventing Trigger work", async () => {
    const state = await setup({ openTickets: 2 });
    await state.resident.enqueueRecovery();
    await state.resident.pollOnce();
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]).toContain("Restart recovery");
    expect(state.prompts[0]).toContain("(none; restart recovery only)");
    await state.resident.stop();
  });

  it("stops model work while the background budget is spent and resumes after it is restored", async () => {
    const state = await setup({ exhausted: true });
    const row = trigger(4);
    state.rows.set(row.id, row);
    await state.resident.enqueue([row]);
    await state.resident.pollOnce();
    expect(state.prompts).toEqual([]);

    state.setExhausted(false);
    await state.resident.pollOnce();
    expect(state.prompts).toHaveLength(1);
    expect(state.prompts[0]).toContain(row.id);
    await state.resident.stop();
  });

  it("pauses an in-flight turn for a person and delivers the batch after resuming", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    let started!: () => void;
    const startedFirst = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const state = await setup({
      prompt: async () => {
        calls += 1;
        if (calls > 1) return;
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
          started();
        });
      },
      abort: () => rejectFirst?.(new Error("aborted by person")),
    });
    const row = trigger(5);
    state.rows.set(row.id, row);
    await state.resident.enqueue([row]);

    const running = state.resident.pollOnce();
    await startedFirst;
    await state.resident.pauseForPerson();
    expect(state.prompts).toHaveLength(1);
    expect(rejectFirst).toBeTypeOf("function");
    await running;

    state.resident.resumeAfterPerson();
    await state.resident.pollOnce();
    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toContain(row.id);
    await state.resident.stop();
  });
});
