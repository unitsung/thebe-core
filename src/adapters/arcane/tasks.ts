import {
  ProviderError,
  type ProviderErrorCode,
} from "../../agent/capabilities/containers.ts";
import type {
  ProductBackgroundTaskProvider,
  ProviderBackgroundTask,
} from "../../agent/background-tasks/product.ts";
import { redactToolOutput } from "../../agent/security/redaction.ts";

type JsonObject = Record<string, unknown>;

const MAX_TASK_ERROR_LENGTH = 2_000;
const DEFAULT_ACTIVITY_LIMIT = 25;
const MAX_ACTIVITY_LIMIT = 100;

export type ArcaneBackgroundTaskProviderOptions = {
  baseUrl: string;
  apiKey: string;
  environmentId?: string;
  limit?: number;
  fetch?: typeof fetch;
};

/**
 * Provider-owned Arcane activity source for the product Activity feed.
 *
 * Checked 2026-09-26 against Arcane `types/activity` (statuses queued, running,
 * success, failed, cancelled) and `backend/api/handlers/activities.go`:
 * `GET /environments/{id}/activities` lists background activities and
 * `POST /environments/{id}/activities/{activityId}/cancel` cancels a running
 * one (409 when it already finished). Cancelling needs an Arcane build with
 * activity cancellation (PR #2756); older builds answer 404.
 */
export class ArcaneBackgroundTaskProvider
  implements ProductBackgroundTaskProvider
{
  readonly service = "arcane";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly environmentId: string;
  private readonly limit: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArcaneBackgroundTaskProviderOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.apiKey = options.apiKey.trim();
    this.environmentId = options.environmentId?.trim() || "0";
    const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
    this.limit = Number.isFinite(limit)
      ? Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Math.trunc(limit)))
      : DEFAULT_ACTIVITY_LIMIT;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async list(): Promise<ProviderBackgroundTask[]> {
    const query = new URLSearchParams({
      start: "0",
      limit: String(this.limit),
      order: "desc",
    });
    const body = await this.requestJSON(
      `${this.environmentPath()}/activities?${query.toString()}`,
    );
    const rows = Array.isArray(body.data) ? body.data : [];
    const tasks: ProviderBackgroundTask[] = [];
    for (const row of rows) {
      const task = toProviderTask(row);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async stop(taskId: string): Promise<void> {
    const id = taskId.trim();
    if (!id) {
      throw new ProviderError("UNKNOWN", "Arcane activity id is required");
    }
    try {
      await this.requestJSON(
        `${this.environmentPath()}/activities/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
      );
    } catch (cause) {
      if (cause instanceof ProviderError && providerStatus(cause) === 409) {
        const finished = new ProviderError(
          "UNKNOWN",
          `Arcane activity ${id} has already finished`,
        );
        (finished as ProviderError & { status?: number }).status = 409;
        throw finished;
      }
      throw cause;
    }
  }

  async stopAll(): Promise<void> {
    const tasks = await this.list();
    await Promise.all(
      tasks
        .filter((task) => task.status === "running")
        .map((task) => this.stop(task.id)),
    );
  }

  private environmentPath(): string {
    return `/api/environments/${encodeURIComponent(this.environmentId)}`;
  }

  private async requestJSON(
    path: string,
    init: { method?: "GET" | "POST" } = {},
  ): Promise<JsonObject> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          "X-Api-Key": this.apiKey,
        },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "Arcane API is unreachable", cause);
    }

    if (!response.ok) {
      const error = new ProviderError(
        statusToCode(response.status),
        `Arcane HTTP ${response.status}`,
      );
      // Keep the provider status so the product HTTP layer can answer with it.
      (error as ProviderError & { status?: number }).status = response.status;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (cause) {
      throw new ProviderError("UNKNOWN", "Arcane returned invalid JSON", cause);
    }
    const object = asObject(parsed);
    if (object.success === false) {
      throw new ProviderError("UNKNOWN", "Arcane API returned an error");
    }
    return object;
  }
}

export function createArcaneBackgroundTaskProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): ArcaneBackgroundTaskProvider | undefined {
  const baseUrl = firstEnv(env, ["THEBE_ARCANE_BASE_URL", "ARCANE_BASE_URL"]);
  const apiKey = firstEnv(env, ["THEBE_ARCANE_API_KEY", "ARCANE_API_KEY"]);
  if (!baseUrl || !apiKey) return undefined;
  const environmentId = arcaneEnvironmentIdFromEnv(env);
  return new ArcaneBackgroundTaskProvider({
    baseUrl,
    apiKey,
    ...(environmentId ? { environmentId } : {}),
  });
}

/** Arcane environment the agent talks to; `0` is Arcane's local environment. */
export function arcaneEnvironmentIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return firstEnv(env, [
    "THEBE_ARCANE_ENVIRONMENT_ID",
    "ARCANE_ENVIRONMENT_ID",
  ]);
}

function firstEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function toProviderTask(value: unknown): ProviderBackgroundTask | undefined {
  const dto = asObject(value);
  const id = stringField(dto, "id");
  if (!id) return undefined;
  const startedAt = stringField(dto, "startedAt") || undefined;
  const finishedAt = stringField(dto, "endedAt") || undefined;
  const updatedAt =
    finishedAt || stringField(dto, "updatedAt") || startedAt || undefined;
  const kind = stringField(dto, "type");
  const name =
    stringField(dto, "resourceName") || stringField(dto, "step") || kind;
  const error = stringField(dto, "error");
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(name ? { name } : {}),
    status: statusForActivity(dto.status, finishedAt),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
    ...(error
      ? { error: redactToolOutput(error).slice(0, MAX_TASK_ERROR_LENGTH) }
      : {}),
  };
}

function statusForActivity(
  value: unknown,
  endedAt: string | undefined,
): ProviderBackgroundTask["status"] {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status === "failed") return "failed";
  if (status === "success" || status === "cancelled") return "stopped";
  if (status === "running" || status === "queued") return "running";
  // Unknown status: trust the timestamps instead of inventing progress.
  return endedAt ? "stopped" : "running";
}

function statusToCode(status: number): ProviderErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 429) return "RATE_LIMITED";
  return "UNKNOWN";
}

function providerStatus(error: unknown): number | undefined {
  const value = (error as { status?: unknown } | undefined)?.status;
  return typeof value === "number" ? value : undefined;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value.trim() : "";
}

