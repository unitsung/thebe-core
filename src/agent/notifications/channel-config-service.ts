import { mkdir } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import type { NotificationAdapter } from "./types.ts";
import {
  createNotificationChannelConfigStore,
  loadNotificationChannelConfig,
  notificationChannelConfigFileName,
  type NotificationChannelConfig,
} from "./channel-config.ts";

export type NotificationChannelConfigService = {
  /** Full config, including secrets; HTTP routes must redact it before responding. */
  get: () => Promise<NotificationChannelConfig>;
  set: (value: unknown) => Promise<NotificationChannelConfig>;
  reload: () => Promise<NotificationChannelConfig>;
  start: () => Promise<void>;
  stop: () => void;
};

/**
 * Owns the owner-only channel credential file and rebuilds adapters after a save. It watches the
 * directory rather than the file because an atomic save replaces the inode; the filename filter keeps
 * unrelated notification settings writes from causing a reload.
 */
export function createNotificationChannelConfigService(options: {
  dir: string;
  buildAdapters: (
    config: NotificationChannelConfig
  ) => readonly NotificationAdapter[];
  onChange: (adapters: readonly NotificationAdapter[]) => void;
  watch?: boolean;
  onError?: (error: unknown) => void;
}): NotificationChannelConfigService {
  const store = createNotificationChannelConfigStore({ dir: options.dir });
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function reload(): Promise<NotificationChannelConfig> {
    const config = await loadNotificationChannelConfig(options.dir);
    options.onChange(options.buildAdapters(config));
    return config;
  }

  async function start(): Promise<void> {
    if (options.watch === false || watcher) return;
    try {
      await mkdir(options.dir, { recursive: true });
      watcher = await watch(options.dir, { persistent: false });
      watcher.on(
        "change",
        (_event: string, filename: string | Buffer | null) => {
          if (
            stopped ||
            String(filename) !== notificationChannelConfigFileName
          ) {
            return;
          }
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = undefined;
            void reload().catch((error) => options.onError?.(error));
          }, 50);
          timer.unref?.();
        }
      );
      watcher.on("error", (error: Error) => options.onError?.(error));
    } catch (error) {
      options.onError?.(error);
    }
  }

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  }

  return {
    get: () => store.get(),
    async set(value) {
      const config = await store.set(value);
      options.onChange(options.buildAdapters(config));
      return config;
    },
    reload,
    start,
    stop,
  };
}
