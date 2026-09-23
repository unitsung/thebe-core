import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  ProductBackgroundTaskProvider,
  ProviderBackgroundTask,
} from "../../agent/background-tasks/product.ts";
import { redactToolOutput } from "../../agent/security/redaction.ts";

type JsonObject = Record<string, unknown>;
type OpenListTaskType =
  | "copy"
  | "offline_download"
  | "offline_download_transfer"
  | "move"
  | "upload"
  | "decompress"
  | "decompress_upload";
type OpenListTaskPhase = "undone" | "done";

const OPENLIST_TASK_TYPES: readonly OpenListTaskType[] = [
  "copy",
  "offline_download",
  "offline_download_transfer",
  "move",
  "upload",
  "decompress",
  "decompress_upload",
];
const OPENLIST_TASK_PHASES: readonly OpenListTaskPhase[] = ["undone", "done"];
const MAX_TASK_ERROR_LENGTH = 2_000;

export type OpenListBackgroundTaskProviderOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
};

type OpenListTaskDTO = {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  error?: unknown;
};

/** Provider-owned OpenList task source for the product Activity feed. */
export class OpenListBackgroundTaskProvider implements ProductBackgroundTaskProvider {
  readonly service = "openlist";

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenListBackgroundTaskProviderOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
  }

  async list(): Promise<ProviderBackgroundTask[]> {
    const tasks = new Map<string, ProviderBackgroundTask>();
    for (const type of OPENLIST_TASK_TYPES) {
      for (const phase of OPENLIST_TASK_PHASES) {
        const data = await this.requestJSON(`/api/task/${type}/${phase}`, "GET");
        if (!Array.isArray(data)) continue;
        for (const raw of data) {
          const task = toProviderTask(type, raw);
          if (task) tasks.set(task.id, task);
        }
      }
    }
    return [...tasks.values()];
  }

  async stop(taskId: string): Promise<void> {
    const parsed = parseProductTaskId(taskId);
    if (!parsed) {
      throw new ProviderError("UNKNOWN", `invalid OpenList task id: ${taskId}`);
    }
    await this.requestJSON(
      `/api/task/${parsed.type}/cancel?tid=${encodeURIComponent(parsed.id)}`,
      "POST",
    );
  }

  async stopAll(): Promise<void> {
    const tasks = await this.list();
    await Promise.all(
      tasks
        .filter((task) => task.status === "running")
        .map((task) => this.stop(task.id)),
    );
  }

  private async requestJSON(path: string, method: "GET" | "POST"): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: this.token,
        },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "OpenList API is unreachable", cause);
    }

    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "UNKNOWN",
        `OpenList API request failed (${response.status})`,
      );
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (cause) {
      throw new ProviderError("UNKNOWN", "OpenList API returned invalid JSON", cause);
    }
    const object = asObject(envelope);
    const code = typeof object.code === "number" ? object.code : 0;
    if (code !== 200) {
      throw new ProviderError(
        code === 401 || code === 403 ? "UNAUTHORIZED" : "UNKNOWN",
        stringField(object, "message") || `OpenList API error (${code})`,
      );
    }
    return object.data;
  }
}

function toProviderTask(
  type: OpenListTaskType,
  value: unknown,
): ProviderBackgroundTask | undefined {
  const dto = asObject(value) as OpenListTaskDTO;
  const id = stringField(dto, "id");
  if (!id) return undefined;
  const startedAt = stringField(dto, "start_time") || undefined;
  const finishedAt = stringField(dto, "end_time") || undefined;
  const error = stringField(dto, "error");
  return {
    id: `${type}:${id}`,
    kind: type,
    ...(stringField(dto, "name") ? { name: stringField(dto, "name") } : {}),
    status: statusForState(dto.state),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    updatedAt: finishedAt ?? startedAt ?? "1970-01-01T00:00:00.000Z",
    ...(error
      ? { error: redactToolOutput(error).slice(0, MAX_TASK_ERROR_LENGTH) }
      : {}),
  };
}

function statusForState(value: unknown): ProviderBackgroundTask["status"] {
  const state = typeof value === "number" ? value : 0;
  if (state === 2) return "stopped";
  if (state === 4 || state === 7) return "failed";
  return "running";
}

function parseProductTaskId(value: string): { type: OpenListTaskType; id: string } | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) return undefined;
  const type = value.slice(0, separator);
  if (!OPENLIST_TASK_TYPES.includes(type as OpenListTaskType)) return undefined;
  const id = value.slice(separator + 1);
  return { type: type as OpenListTaskType, id };
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value.trim() : "";
}
