import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  CloudTransferProvider,
  CloudTransferState,
} from "../../agent/capabilities/pipeline.ts";

type Json = Record<string, unknown>;

/**
 * OpenList offline download as a network-drive transfer provider. The file
 * manager fetches the share/direct link into the destination folder; the
 * acquisition job polls the task list until it is done, then scans and verifies.
 */
export class OpenListTransferProvider implements CloudTransferProvider {
  readonly service = "openlist";
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    baseUrl: string;
    token: string;
    fetch?: typeof fetch;
  }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: Json
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: this.token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 || response.status === 403)
      throw new ProviderError("UNAUTHORIZED", "OpenList rejected the token");
    if (!response.ok)
      throw new ProviderError(
        "UNKNOWN",
        `OpenList request failed (${response.status})`
      );
    const payload = (await response.json()) as Json;
    if (payload.code !== 200) {
      throw new ProviderError(
        payload.code === 401 || payload.code === 403
          ? "UNAUTHORIZED"
          : "UNKNOWN",
        `OpenList: ${typeof payload.message === "string" ? payload.message.slice(0, 200) : `code ${String(payload.code)}`}`
      );
    }
    return payload.data;
  }

  async submit(input: {
    source: string;
    destinationDir: string;
    tool?: string;
  }): Promise<{ handle: string }> {
    const urls = [input.source.trim()].filter(Boolean);
    if (urls.length === 0)
      throw new ProviderError("UNKNOWN", "A source link is required");
    const data = (await this.call("POST", "/api/fs/add_offline_download", {
      urls,
      path: cleanPath(input.destinationDir),
      tool: input.tool?.trim() || "SimpleHttp",
      delete_policy: "delete_on_upload_succeed",
    })) as Json | null;
    const handle = firstTaskId(data);
    if (!handle)
      throw new ProviderError(
        "UNKNOWN",
        "OpenList did not return a transfer task id"
      );
    return { handle };
  }

  async status(handle: string): Promise<CloudTransferState> {
    const running = findTask(
      await this.call("GET", "/api/task/offline_download/undone"),
      handle
    );
    if (running) {
      const progress = progressOf(running);
      return progress === undefined
        ? { state: "pending" }
        : { state: "pending", progress };
    }
    const finished = findTask(
      await this.call("GET", "/api/task/offline_download/done"),
      handle
    );
    if (!finished) return { state: "pending" };
    // OpenList task states: 2 is a completed task; anything else in the done
    // list (canceled / errored / failed) is a failure for this job.
    if (typeof finished.state === "number" && finished.state !== 2) {
      return {
        state: "error",
        message:
          stringField(finished, "error") || "the transfer did not complete",
      };
    }
    const name = stringField(finished, "name");
    return name
      ? { state: "completed", contentName: name }
      : { state: "completed" };
  }
}

function cleanPath(value: string): string {
  const path = `/${value.trim().replace(/^\/+/, "")}`
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/$/, "$1");
  if (path.split("/").includes(".."))
    throw new ProviderError("UNKNOWN", "Path must not contain ..");
  return path;
}

function firstTaskId(data: Json | null): string {
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) return "";
  for (const task of tasks) {
    if (
      task &&
      typeof task === "object" &&
      typeof (task as Json).id === "string"
    )
      return (task as Json).id as string;
  }
  return "";
}

function findTask(data: unknown, handle: string): Json | undefined {
  if (!Array.isArray(data)) return undefined;
  for (const item of data) {
    if (item && typeof item === "object" && (item as Json).id === handle)
      return item as Json;
  }
  return undefined;
}

function progressOf(task: Json): number | undefined {
  const value = task.progress;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const fraction = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, fraction));
}

function stringField(object: Json, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value.trim() : "";
}

export function createOpenListTransferProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): OpenListTransferProvider | undefined {
  const pick = (...values: Array<string | undefined>) =>
    values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
  const baseUrl = pick(env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL);
  const token = pick(env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN);
  return baseUrl && token
    ? new OpenListTransferProvider({ baseUrl, token })
    : undefined;
}
