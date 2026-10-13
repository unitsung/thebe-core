import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTask } from "../../../agent/runtime/interface.ts";

type BashExecutionOptions = {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};

export type BashOperations = {
  exec(
    command: string,
    cwd: string,
    options: BashExecutionOptions
  ): Promise<{ exitCode: number | null }>;
};

export type BackgroundTaskRegistryOptions = {
  dir?: string;
  sessionId?: string;
  now?: () => string;
};

type BackgroundTaskRecord = BackgroundTask & {
  pid: number;
  startedAt: string;
  updatedAt: string;
};

const MAX_TERMINAL_TASKS = 100;

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function hasDetachedJob(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "&") continue;
    const previous = command[index - 1];
    const next = command[index + 1];
    if (previous === "&" || previous === ">" || next === "&" || next === ">") {
      continue;
    }
    return true;
  }
  return false;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(pid: number): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The detached job may not own a process group.
    }
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may have already exited.
  }
}

function stopped(task: BackgroundTaskRecord, finishedAt: string): void {
  task.status = "stopped";
  task.finishedAt = finishedAt;
  task.updatedAt = finishedAt;
}

function parsePids(value: string): number[] {
  return [
    ...new Set(
      value
        .split(/\s+/)
        .map((part) => Number(part))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    ),
  ];
}

function validRecord(value: unknown): value is BackgroundTaskRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BackgroundTaskRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.status === "string" &&
    ["running", "stopped", "failed"].includes(record.status) &&
    typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

/** Tracks detached jobs launched through Pi's local Bash operations. */
export function createBackgroundTaskRegistry(
  options: BackgroundTaskRegistryOptions = {}
) {
  const now = options.now ?? (() => new Date().toISOString());
  const tasks = new Map<string, BackgroundTaskRecord>();
  const storageDir = options.dir;
  const storagePath =
    storageDir && options.sessionId
      ? join(
          storageDir,
          `${createHash("sha256").update(options.sessionId).digest("hex")}.json`
        )
      : undefined;
  let persistTail: Promise<void> = Promise.resolve();

  const ready = (async () => {
    if (!storagePath || !storageDir) return;
    try {
      await mkdir(storageDir, { recursive: true });
      const parsed: unknown = JSON.parse(await readFile(storagePath, "utf8"));
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (validRecord(value)) tasks.set(value.id, value);
      }
    } catch {
      // Missing or corrupt read-model snapshots do not block the runtime.
    }
  })();

  async function persist(): Promise<void> {
    if (!storagePath || !storageDir) return;
    const next = persistTail.then(async () => {
      await mkdir(storageDir, { recursive: true });
      const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify([...tasks.values()])}\n`,
          { encoding: "utf8", mode: 0o600 }
        );
        await rename(temporaryPath, storagePath);
      } finally {
        await unlink(temporaryPath).catch(() => {});
      }
    });
    persistTail = next.catch(() => {});
    await next;
  }

  function markFinishedTasks(): boolean {
    let changed = false;
    const finishedAt = now();
    for (const task of tasks.values()) {
      if (task.status === "running" && !processIsAlive(task.pid)) {
        stopped(task, finishedAt);
        changed = true;
      }
    }
    return changed;
  }

  function trimTerminalTasks(): boolean {
    const terminal = [...tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    let changed = false;
    while (terminal.length > MAX_TERMINAL_TASKS) {
      const task = terminal.shift();
      if (!task) break;
      tasks.delete(task.id);
      changed = true;
    }
    return changed;
  }

  return {
    wrap(operations: BashOperations): BashOperations {
      return {
        async exec(command, cwd, options) {
          await ready;
          if (!hasDetachedJob(command)) {
            return operations.exec(command, cwd, options);
          }

          const marker = join(
            tmpdir(),
            `thebe-background-task-${randomUUID()}.txt`
          );
          const wrapped = [
            command,
            "__thebe_background_exit=$?",
            `printf '%s\\n' "$(jobs -pr)" > ${shellQuote(marker)}`,
            'exit "$__thebe_background_exit"',
          ].join("\n");
          try {
            const result = await operations.exec(wrapped, cwd, options);
            const markerValue = await readFile(marker, "utf8").catch(() => "");
            const pids = parsePids(markerValue);
            const startedAt = now();
            for (const pid of pids) {
              const id = randomUUID();
              const task: BackgroundTaskRecord = {
                id,
                name: command,
                pid,
                status: processIsAlive(pid) ? "running" : "stopped",
                startedAt,
                updatedAt: startedAt,
              };
              if (task.status === "stopped") {
                task.finishedAt = startedAt;
              }
              tasks.set(id, task);
            }
            const trimmed = trimTerminalTasks();
            if (pids.length > 0 || trimmed) {
              await persist().catch(() => {});
            }
            return result;
          } finally {
            await unlink(marker).catch(() => {});
          }
        },
      };
    },

    async list(): Promise<BackgroundTask[]> {
      await ready;
      const changed = markFinishedTasks();
      const trimmed = trimTerminalTasks();
      if (changed || trimmed) {
        await persist().catch(() => {});
      }
      return [...tasks.values()].map((task) => ({ ...task }));
    },

    async stop(taskId: string): Promise<void> {
      await ready;
      const changed = markFinishedTasks();
      const trimmed = trimTerminalTasks();
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") {
        if (changed || trimmed) await persist().catch(() => {});
        return;
      }
      stopProcess(task.pid);
      stopped(task, now());
      await persist().catch(() => {});
    },
  };
}

export type BackgroundTaskRegistry = ReturnType<
  typeof createBackgroundTaskRegistry
>;
