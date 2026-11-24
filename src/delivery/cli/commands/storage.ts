import {
  createFilesProvider,
  importStorageFromEnv,
  loadStorageConfig,
  removeStorageBackend,
  setDefaultStorageBackend,
  storageConfigView,
  upsertStorageBackend,
  type StorageConfigView,
} from "../../../app/storage-config.ts";
import type { CliCommand } from "../args.ts";

export type StorageCliCommand = Extract<
  CliCommand,
  { kind: `storage-${string}` }
>;

export function isStorageCliCommand(
  command: CliCommand
): command is StorageCliCommand {
  return command.kind.startsWith("storage-");
}

/** Storage commands run before bootstrap: they only read and write config.json. */
export async function runStorageCommand(
  command: StorageCliCommand,
  options: {
    log?: (line: string) => void;
    error?: (line: string) => void;
  } = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  try {
    switch (command.kind) {
      case "storage-list": {
        printView(storageConfigView(), log, error);
        return 0;
      }
      case "storage-add": {
        const view = upsertStorageBackend(command.backend, {
          makeDefault: command.makeDefault,
        });
        log(
          `saved ${command.backend.id} (${command.backend.type})${command.makeDefault ? " as default" : ""}`
        );
        printView(view, log, error);
        return 0;
      }
      case "storage-remove": {
        const view = removeStorageBackend(command.id);
        log(`removed ${command.id}`);
        printView(view, log, error);
        return 0;
      }
      case "storage-default": {
        const view = setDefaultStorageBackend(command.id);
        log(`default storage: ${view.default}`);
        return 0;
      }
      case "storage-import-env": {
        const view = importStorageFromEnv();
        log("imported storage environment variables into config.json");
        printView(view, log, error);
        return 0;
      }
      case "storage-test": {
        return await testBackends(command.id, log, error);
      }
    }
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

async function testBackends(
  id: string | undefined,
  log: (line: string) => void,
  error: (line: string) => void
): Promise<number> {
  const loaded = loadStorageConfig();
  if (loaded.backends.length === 0) {
    error("No storage backend is configured");
    for (const issue of loaded.issues) error(issue.message);
    return 1;
  }
  const targets = id
    ? loaded.backends.filter((backend) => backend.id === id)
    : loaded.backends;
  if (targets.length === 0) {
    error(`unknown storage backend: ${id}`);
    return 1;
  }
  let failed = 0;
  for (const backend of targets) {
    try {
      const provider = createFilesProvider(backend);
      const listing = await provider.list({ path: "/" });
      log(`${backend.id}\tok\t${listing.total} entries at /`);
    } catch (cause) {
      failed += 1;
      error(
        `${backend.id}\tfailed\t${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }
  return failed > 0 ? 1 : 0;
}

function printView(
  view: StorageConfigView,
  log: (line: string) => void,
  error: (line: string) => void
): void {
  log(`config: ${view.path} (${sourceLabel(view.source)})`);
  if (view.backends.length === 0) {
    log("(no storage backends configured)");
  } else {
    log(`default: ${view.default ?? view.backends[0]!.id}`);
    for (const backend of view.backends) {
      log(
        [
          backend.id === view.default ? "*" : " ",
          backend.id,
          backend.type,
          describeTarget(backend),
        ].join("\t")
      );
    }
  }
  for (const issue of view.issues) error(`warning: ${issue}`);
}

function describeTarget(
  backend: StorageConfigView["backends"][number]
): string {
  if (backend.type === "local") return (backend.roots ?? []).join(", ");
  if (backend.type === "openlist") return backend.baseUrl ?? "";
  const auth = [
    backend.username ? `username ${backend.username}` : "",
    backend.hasToken ? "token set" : "",
    backend.hasPassword ? "password set" : "",
  ].filter(Boolean);
  return `${backend.url ?? ""}${auth.length ? ` (${auth.join(", ")})` : ""}`;
}

function sourceLabel(source: StorageConfigView["source"]): string {
  return source === "config"
    ? "config.json"
    : source === "env"
      ? "environment; run `thebe storage import-env` to save it"
      : "empty";
}
