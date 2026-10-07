import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { httpError } from "../types.ts";
import { redactToolOutput } from "../security/redaction.ts";
import type { ThebeAgent } from "../interface.ts";
import type { GoalSchedule, GoalScheduleInput } from "./types.ts";

type GoalPort = Pick<ThebeAgent, "createSession" | "startGoal" | "listGoals">;

/** A single Core process owns scheduling. Reservations are durable before a
 * Goal starts; an interrupted dispatch is never replayed after restart. */
export function createScheduleApi(options: {
  dir?: string;
  now: () => Date;
  goals: GoalPort;
  checkWritable: () => void;
  isQuiesced: () => boolean;
}) {
  let rows: GoalSchedule[] = [];
  let loaded = false;
  let chain = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;

  async function persist(next: GoalSchedule[]) {
    if (options.dir) {
      await mkdir(options.dir, { recursive: true });
      const temporary = join(options.dir, `${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, join(options.dir, "schedules.json"));
    }
    rows = next;
  }

  async function load() {
    if (loaded) return;
    if (options.dir) {
      try {
        const data: unknown = JSON.parse(await readFile(join(options.dir, "schedules.json"), "utf8"));
        if (!Array.isArray(data) || data.length > 200) throw new Error("Invalid schedule store");
        rows = data.map(value => {
          const row = value as GoalSchedule;
          validate(row);
          if (!row.id || typeof row.enabled !== "boolean") throw new Error("Invalid schedule store");
          return row.dispatching ? { ...row, dispatching: false, lastError: "Core restarted during dispatch; inspect the linked Goal before scheduling another run." } : row;
        });
        await persist(rows);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    loaded = true;
  }

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = chain.then(async () => { await load(); return operation(); });
    chain = result.then(() => {}, () => {});
    return result;
  }

  const copy = (row: GoalSchedule): GoalSchedule => ({ ...row, criteria: row.criteria?.slice() });
  const find = (id: string) => {
    const row = rows.find(row => row.id === id);
    if (!row) throw httpError(404, "Schedule not found");
    return row;
  };
  async function save(row: GoalSchedule) {
    await persist(rows.map(value => value.id === row.id ? row : value));
  }

  async function dispatch(row: GoalSchedule, manual = false) {
    options.checkWritable();
    const previous = row.lastSessionId ? (await options.goals.listGoals()).find(goal => goal.thebeSessionId === row.lastSessionId) : undefined;
    if (previous && ["running", "pausing", "paused"].includes(previous.status)) {
      if (manual) throw httpError(409, "The previous scheduled Goal is still active; finish or stop it first");
      await save({ ...advance(row), lastError: "Occurrence skipped because the previous Goal is still active." });
      return;
    }
    const stamp = options.now().toISOString();
    const reserved: GoalSchedule = { ...(manual ? row : advance(row)), lastRunAt: stamp, updatedAt: stamp, lastSessionId: undefined, lastError: undefined, dispatching: true };
    await save(reserved);
    try {
      const session = await options.goals.createSession({ title: row.title, labels: { kind: "goal", scheduleId: row.id } });
      reserved.lastSessionId = session.thebeSessionId;
      await save({ ...reserved });
      await options.goals.startGoal({ thebeSessionId: session.thebeSessionId, goal: row.goal, criteria: row.criteria, maxIterations: row.maxIterations });
      await save({ ...reserved, dispatching: false });
    } catch (error) {
      await save({ ...reserved, dispatching: false, lastError: redactToolOutput(error instanceof Error ? error.message : String(error)).slice(0, 2000) });
      if (manual) throw error;
    }
  }

  function advance(row: GoalSchedule): GoalSchedule {
    const stamp = options.now().toISOString();
    if (!row.intervalMinutes) return { ...row, enabled: false, nextRunAt: undefined, updatedAt: stamp };
    const interval = row.intervalMinutes * 60_000;
    const due = Date.parse(row.nextRunAt ?? row.startAt);
    const next = due + (Math.floor(Math.max(0, options.now().getTime() - due) / interval) + 1) * interval;
    return { ...row, nextRunAt: new Date(next).toISOString(), updatedAt: stamp };
  }

  async function tick() {
    return serial(async () => {
      if (options.isQuiesced()) return;
      for (const row of rows.slice()) {
        if (row.enabled && row.nextRunAt && Date.parse(row.nextRunAt) <= options.now().getTime()) await dispatch(row);
      }
    });
  }
  function arm() {
    if (!active) return;
    timer = setTimeout(() => {
      void tick().catch(() => { /* Store failures remain visible on reads; retry without dispatching unpersisted work. */ }).finally(arm);
    }, 1000);
    timer.unref();
  }

  return {
    listSchedules: () => serial(async () => rows.map(copy)),
    getSchedule: (id: string) => serial(async () => copy(find(id))),
    createSchedule: (input: GoalScheduleInput) => serial(async () => {
      options.checkWritable();
      const normalized = validate(input);
      if (rows.length >= 200) throw httpError(409, "Schedule limit reached (200)");
      const stamp = options.now().toISOString();
      const row: GoalSchedule = { ...normalized, id: randomUUID(), enabled: true, createdAt: stamp, updatedAt: stamp, nextRunAt: normalized.startAt };
      await persist([...rows, row]);
      return copy(row);
    }),
    updateSchedule: (id: string, input: GoalScheduleInput) => serial(async () => {
      options.checkWritable();
      const row = find(id);
      const normalized = validate(input);
      const updated = { ...row, ...normalized, criteria: normalized.criteria, intervalMinutes: normalized.intervalMinutes, maxIterations: normalized.maxIterations, nextRunAt: row.enabled ? normalized.startAt : undefined, updatedAt: options.now().toISOString() };
      await save(updated);
      return copy(updated);
    }),
    setScheduleEnabled: (id: string, enabled: boolean) => serial(async () => {
      options.checkWritable();
      const row = find(id);
      let updated: GoalSchedule = { ...row, enabled, updatedAt: options.now().toISOString(), nextRunAt: enabled ? row.nextRunAt ?? row.startAt : undefined };
      // Resuming recurrence skips missed occurrences; a one-shot past time is
      // explicitly scheduled for the next tick.
      if (enabled && row.intervalMinutes && Date.parse(updated.nextRunAt!) < options.now().getTime()) updated = advance(updated);
      await save(updated);
      return copy(updated);
    }),
    deleteSchedule: (id: string) => serial(async () => {
      options.checkWritable();
      find(id);
      await persist(rows.filter(row => row.id !== id));
    }),
    runSchedule: (id: string) => serial(async () => { await dispatch(find(id), true); return copy(find(id)); }),
    tick,
    start() { if (!active) { active = true; arm(); } },
    async stop() { active = false; if (timer) clearTimeout(timer); await chain; },
  };
}

export function validate(input: GoalScheduleInput): GoalScheduleInput {
  if (!input || typeof input !== "object") throw httpError(400, "Invalid schedule", "invalid_body");
  const text = (value: unknown, name: string, max: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw httpError(400, `${name} must contain 1-${max} characters`, "invalid_body");
    return value.trim();
  };
  const title = text(input.title, "title", 200);
  const goal = text(input.goal, "goal", 16000);
  if (typeof input.startAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.startAt) || !Number.isFinite(Date.parse(input.startAt))) throw httpError(400, "startAt must be an ISO date-time", "invalid_body");
  if (input.intervalMinutes !== undefined && (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 5 || input.intervalMinutes > 525600)) throw httpError(400, "intervalMinutes must be an integer from 5 to 525600", "invalid_body");
  if (input.maxIterations !== undefined && (!Number.isInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > 32)) throw httpError(400, "maxIterations must be an integer from 1 to 32", "invalid_body");
  if (input.criteria !== undefined && (!Array.isArray(input.criteria) || input.criteria.length > 32 || input.criteria.some(value => typeof value !== "string" || !value.trim() || value.length > 2000))) throw httpError(400, "criteria must contain up to 32 nonempty strings", "invalid_body");
  return { title, goal, startAt: new Date(input.startAt).toISOString(), criteria: input.criteria?.map(value => value.trim()), intervalMinutes: input.intervalMinutes, maxIterations: input.maxIterations };
}
