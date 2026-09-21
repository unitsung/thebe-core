import type { BackgroundTask } from "../runtime/interface.ts";

export type ProductBackgroundTask = {
  id: string;
  sessionId: string;
  name?: string;
  pid?: number;
  port?: number;
  status: BackgroundTask["status"];
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};

export function toProductBackgroundTask(
  sessionId: string,
  task: BackgroundTask,
): ProductBackgroundTask {
  const updatedAt = task.updatedAt ?? task.finishedAt ?? task.startedAt ?? "1970-01-01T00:00:00.000Z";
  return {
    id: task.id,
    sessionId,
    ...(task.name ? { name: task.name } : {}),
    ...(task.pid === undefined ? {} : { pid: task.pid }),
    ...(task.port === undefined ? {} : { port: task.port }),
    status: task.status,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    updatedAt,
  };
}

export function backgroundTaskActivityId(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}
