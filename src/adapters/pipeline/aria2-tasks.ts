import type {
  ProductBackgroundTaskProvider,
  ProviderBackgroundTask,
} from "../../agent/background-tasks/product.ts";
import type { DownloadItem } from "../../agent/capabilities/pipeline.ts";
import type { Aria2DownloadProvider } from "./aria2-downloads.ts";

/**
 * aria2 downloads as background tasks, so they appear in Activity beside qBittorrent's. It reads through
 * the same {@link Aria2DownloadProvider} the download hub uses, so there is one RPC client and one secret.
 * `stop` pauses; it never removes a task or its files.
 *
 * aria2 reports no timestamps, so this remembers when it first saw a task and when its state last changed
 * while Core was watching. A task first seen already finished carries no time, so after a restart old
 * finished downloads stay in history and do not ask for the person again.
 */
export class Aria2BackgroundTaskProvider implements ProductBackgroundTaskProvider {
  readonly service = "aria2";
  private readonly seen = new Map<
    string,
    { status: string; startedAt?: string; changedAt?: string }
  >();

  constructor(
    private readonly downloads: Pick<Aria2DownloadProvider, "list" | "pause">,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(): Promise<ProviderBackgroundTask[]> {
    const items = await this.downloads.list({ limit: 100 });
    const stamp = this.now().toISOString();
    return items.map((item) => this.toTask(item, stamp));
  }

  private toTask(item: DownloadItem, stamp: string): ProviderBackgroundTask {
    const status = toStatus(item);
    const known = this.seen.get(item.id);
    const entry =
      known && known.status === status
        ? known
        : {
            status,
            startedAt:
              known?.startedAt ?? (status === "running" ? stamp : undefined),
            // The first sight of an already finished task is not a change worth surfacing.
            changedAt: known || status === "running" ? stamp : undefined,
          };
    this.seen.set(item.id, entry);
    return {
      id: item.id,
      kind: "download",
      name: item.name,
      status,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(status !== "running" && entry.changedAt
        ? { finishedAt: entry.changedAt }
        : {}),
      ...(entry.changedAt ? { updatedAt: entry.changedAt } : {}),
      ...(status === "failed"
        ? { error: item.message ?? "aria2 reports a download error" }
        : {}),
    };
  }

  async stop(taskId: string): Promise<void> {
    await this.downloads.pause([taskId]);
  }

  async stopAll(): Promise<void> {
    const running = (await this.list()).filter(
      (task) => task.status === "running"
    );
    for (const task of running) await this.downloads.pause([task.id]);
  }
}

function toStatus(item: DownloadItem): ProviderBackgroundTask["status"] {
  if (item.phase === "error") return "failed";
  if (item.phase === "downloading" || item.phase === "queued") return "running";
  return "stopped";
}
