import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";

export const DEFAULT_TRIGGER_FANOUT_RETENTION = 1000;

const ID_RE = /^[a-f0-9]{32}$/;

export type TriggerFanoutDisposition = {
  triggerId: string;
  recipients: string[];
  delivered: string[];
  at: string;
};

export type TriggerFanoutDispositionStore = {
  get(triggerId: string): Promise<TriggerFanoutDisposition | undefined>;
  /**
   * Persists the first recipient decision for one Trigger. Later calls return
   * that same decision, including an empty recipient list.
   */
  plan(input: {
    triggerId: string;
    recipients: readonly string[];
    at: string;
  }): Promise<TriggerFanoutDisposition>;
  /** Records that one planned recipient is durably complete. */
  markDelivered(
    triggerId: string,
    recipient: string
  ): Promise<TriggerFanoutDisposition | undefined>;
};

function cloneDisposition(
  disposition: TriggerFanoutDisposition
): TriggerFanoutDisposition {
  return {
    ...disposition,
    recipients: [...disposition.recipients],
    delivered: [...disposition.delivered],
  };
}

function parseDisposition(
  value: unknown
): TriggerFanoutDisposition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<TriggerFanoutDisposition>;
  if (
    typeof row.triggerId !== "string" ||
    !ID_RE.test(row.triggerId) ||
    typeof row.at !== "string" ||
    row.at.length === 0 ||
    !Array.isArray(row.recipients) ||
    !row.recipients.every(
      (recipient) => typeof recipient === "string" && ID_RE.test(recipient)
    )
  ) {
    return undefined;
  }
  const delivered = row.delivered ?? [];
  if (
    !Array.isArray(delivered) ||
    !delivered.every(
      (recipient) => typeof recipient === "string" && ID_RE.test(recipient)
    )
  ) {
    return undefined;
  }
  return {
    triggerId: row.triggerId,
    recipients: [...new Set(row.recipients)],
    delivered: [...new Set(delivered)],
    at: row.at,
  };
}

/**
 * The durable, immutable recipient snapshot for Trigger fan-out. It is written
 * before any Ticket Input so a replay after a crash handles exactly the Tickets
 * that were live at the original event, never Tickets created afterwards.
 */
export function createTriggerFanoutDispositionStore(
  options: {
    dir?: string;
    maxItems?: number;
  } = {}
): TriggerFanoutDispositionStore {
  const maxItems = Math.max(
    0,
    options.maxItems ?? DEFAULT_TRIGGER_FANOUT_RETENTION
  );
  const memory = new Map<string, TriggerFanoutDisposition>();
  let loaded = !options.dir;
  let loading: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loading ??= load().finally(() => {
      loaded = true;
    });
    return loading;
  }

  async function load(): Promise<void> {
    const dir = options.dir;
    if (!dir) return;
    let names: string[];
    try {
      names = (await readdir(dir)).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".tmp.json")
      );
    } catch {
      return;
    }
    const rows: TriggerFanoutDisposition[] = [];
    for (const name of names) {
      try {
        const row = JSON.parse(
          await readFile(join(dir, name), "utf8")
        ) as unknown;
        const parsed = parseDisposition(row);
        if (parsed) {
          rows.push(parsed);
        }
      } catch {
        // A damaged disposition is skipped and can be re-planned safely.
      }
    }
    rows.sort((left, right) => left.at.localeCompare(right.at));
    for (const row of rows) memory.set(row.triggerId, row);
  }

  async function persist(disposition: TriggerFanoutDisposition): Promise<void> {
    const dir = options.dir;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(
      join(dir, `${disposition.triggerId}.json`),
      `${JSON.stringify(disposition)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  async function prune(): Promise<void> {
    while (memory.size > maxItems) {
      const oldest = memory.keys().next().value;
      if (!oldest) return;
      memory.delete(oldest);
      if (options.dir) {
        await unlink(join(options.dir, `${oldest}.json`)).catch(() => {});
      }
    }
  }

  return {
    async get(triggerId) {
      await ensureLoaded();
      if (!ID_RE.test(triggerId)) return undefined;
      const row = memory.get(triggerId);
      return row ? cloneDisposition(row) : undefined;
    },
    plan(input) {
      return serial(async () => {
        await ensureLoaded();
        if (!ID_RE.test(input.triggerId)) {
          throw new Error(
            "Trigger fan-out disposition needs a valid Trigger id"
          );
        }
        if (input.recipients.some((recipient) => !ID_RE.test(recipient))) {
          throw new Error("Trigger fan-out disposition needs valid Ticket ids");
        }
        const existing = memory.get(input.triggerId);
        if (existing) return cloneDisposition(existing);

        const disposition: TriggerFanoutDisposition = {
          triggerId: input.triggerId,
          recipients: [...new Set(input.recipients)],
          delivered: [],
          at: input.at,
        };
        await persist(disposition);
        memory.set(disposition.triggerId, disposition);
        await prune();
        return cloneDisposition(disposition);
      });
    },
    markDelivered(triggerId, recipient) {
      return serial(async () => {
        await ensureLoaded();
        if (!ID_RE.test(triggerId) || !ID_RE.test(recipient)) {
          throw new Error("Trigger fan-out delivery needs valid ids");
        }
        const existing = memory.get(triggerId);
        if (!existing) return undefined;
        if (existing.delivered.includes(recipient)) {
          return cloneDisposition(existing);
        }
        const next: TriggerFanoutDisposition = {
          ...existing,
          delivered: [...existing.delivered, recipient],
        };
        await persist(next);
        memory.set(triggerId, next);
        return cloneDisposition(next);
      });
    },
  };
}
