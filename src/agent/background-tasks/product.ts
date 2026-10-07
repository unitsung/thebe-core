import type { BackgroundTask } from "../runtime/interface.ts";

/** Provider-native handle for the resource a task belongs to. */
export type ProviderBackgroundTaskResource = {
  /** Provider-native kind, lowercased, e.g. `container`. */
  kind: string;
  /** Provider-native resource id. */
  id: string;
};

export type ProviderBackgroundTask = {
  id: string;
  kind?: string;
  name?: string;
  status: BackgroundTask["status"];
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  error?: string;
  resource?: ProviderBackgroundTaskResource;
  /** Provider-produced bounded result; never included directly in Activity. */
  output?: { content: string; contentType?: string };
};

export type ProductBackgroundTaskProvider = {
  service: string;
  list(): Promise<ProviderBackgroundTask[]>;
  stop(taskId: string): Promise<void>;
  stopAll(): Promise<void>;
};

export type ProductBackgroundTaskResource = ProviderBackgroundTaskResource & {
  /** Provider that owns the resource, e.g. `arcane`. */
  provider: string;
};

export type ProductBackgroundTask = {
  id: string;
  sessionId: string;
  provider?: string;
  kind?: string;
  name?: string;
  pid?: number;
  port?: number;
  status: BackgroundTask["status"];
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  error?: string;
  resource?: ProductBackgroundTaskResource;
  artifactId?: string;
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

export function providerBackgroundTaskSessionId(service: string): string {
  const normalized = service.trim().toLowerCase();
  if (!normalized) throw new Error("background task provider service is required");
  return `provider-${normalized}`;
}

export function toProductProviderBackgroundTask(
  service: string,
  task: ProviderBackgroundTask,
): ProductBackgroundTask {
  const updatedAt = task.updatedAt ?? task.finishedAt ?? task.startedAt ?? "1970-01-01T00:00:00.000Z";
  return {
    id: task.id,
    sessionId: providerBackgroundTaskSessionId(service),
    provider: service,
    ...(task.kind ? { kind: task.kind } : {}),
    ...(task.name ? { name: task.name } : {}),
    status: task.status,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    updatedAt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.resource
      ? {
          resource: {
            kind: task.resource.kind,
            provider: service,
            id: task.resource.id,
          },
        }
      : {}),
  };
}

export function backgroundTaskActivityId(sessionId: string, taskId: string): string {
  return `${sessionId}:${taskId}`;
}
