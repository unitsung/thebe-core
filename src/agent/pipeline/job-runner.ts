import { randomUUID } from "node:crypto";
import type {
  CloudTransferProvider,
  DownloadProvider,
  FilesProvider,
  LibraryRefreshProvider,
} from "../capabilities/pipeline.ts";
import type { MediaLibraryProvider } from "../capabilities/media.ts";

/**
 * Deterministic acquisition job.
 *
 * Two kinds share one durable state machine:
 * - `torrent` follows download → place → scan → verify (e.g. qBittorrent → OpenList → Emby).
 * - `cloud_transfer` first fetches a share/direct link into the file manager
 *   with a network-drive transfer, then runs the same place → scan → verify.
 *
 * The model chooses the release and the folders once; this state machine runs
 * every later step, classifies failures and retries in fixed, bounded ways, so
 * recovery never depends on the model remembering a plan.
 */
export type JobStage =
  | "submit"
  | "download"
  | "place"
  | "scan"
  | "verify"
  | "done"
  | "failed";

export type JobKind = "torrent" | "cloud_transfer";

export type JobSpec = {
  /** Defaults to `torrent` for existing callers. */
  kind?: JobKind;
  /** What to look for in the media server afterwards, e.g. the movie title. */
  title: string;
  /** torrent: `magnet:` link of the release the user chose. */
  magnet?: string;
  /** Downloader-side save directory (optional). */
  savePath?: string;
  category?: string;
  /** cloud_transfer: share or direct link the transfer provider fetches. */
  transferSource?: string;
  /** cloud_transfer: provider-side downloader name, e.g. `115 Cloud`. */
  transferTool?: string;
  /** Directory in the file manager where the transfer's output appears. */
  filesSourceDir: string;
  /** Directory in the file manager that the media server watches. */
  libraryDir: string;
  mediaServer?: "emby" | "jellyfin";
  year?: number;
};

export type Job = Omit<JobSpec, "kind"> & {
  id: string;
  kind: JobKind;
  /** torrent info-hash; absent for a cloud transfer. */
  hash?: string;
  /** cloud_transfer: handle returned by the transfer provider. */
  transferHandle?: string;
  stage: JobStage;
  /** Folder or file name of the finished download/transfer. */
  contentName?: string;
  attempts: Record<string, number>;
  copiedAt?: number;
  log: Array<{ at: string; stage: JobStage; message: string }>;
  failure?: { stage: JobStage; reason: string; advice: string };
  createdAt: string;
  updatedAt: string;
};

export type JobDeps = {
  downloads?: DownloadProvider;
  /** Network-drive transfer backend for `kind: "cloud_transfer"`. */
  transfer?: CloudTransferProvider;
  files: FilesProvider;
  libraries?: LibraryRefreshProvider[];
  media?: Partial<Record<"emby" | "jellyfin", MediaLibraryProvider>>;
  now?: () => Date;
};

export interface JobStore {
  load(): Job[];
  save(jobs: Job[]): void;
}

export const MAX_ATTEMPTS = { copy: 3, scan: 3, readd: 1 } as const;

/** info-hash from a magnet link (hex or base32). */
export function magnetHash(magnet: string): string | undefined {
  const raw = /xt=urn:btih:([A-Za-z0-9]+)/i.exec(magnet)?.[1];
  if (!raw) return undefined;
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(raw)) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const char of raw.toUpperCase())
      bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
    let hex = "";
    for (let i = 0; i + 4 <= bits.length; i += 4)
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex.slice(0, 40);
  }
  return undefined;
}

export function createJob(spec: JobSpec, now: Date): Job {
  const kind = spec.kind ?? "torrent";
  const stamp = now.toISOString();
  const base = {
    ...spec,
    kind,
    id: randomUUID().slice(0, 8),
    stage: "submit" as const,
    attempts: {},
    log: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  if (kind === "cloud_transfer") {
    if (!spec.transferSource?.trim()) {
      throw new Error("transferSource is required for a cloud transfer job");
    }
    return base;
  }
  const hash = magnetHash(spec.magnet ?? "");
  if (!hash) throw new Error("magnet must contain a valid btih info-hash");
  return { ...base, hash };
}

function note(job: Job, message: string, now: Date) {
  job.log.push({ at: now.toISOString(), stage: job.stage, message });
  if (job.log.length > 40) job.log.splice(0, job.log.length - 40);
  job.updatedAt = now.toISOString();
}

function fail(job: Job, reason: string, advice: string, now: Date) {
  job.failure = { stage: job.stage, reason, advice };
  note(job, `failed: ${reason}`, now);
  job.stage = "failed";
}

const bump = (job: Job, key: string) =>
  (job.attempts[key] = (job.attempts[key] ?? 0) + 1);

/**
 * Performs whatever can be done right now and returns. It never sleeps, so a
 * multi-hour download simply leaves the job in `download` until the next call.
 */
export async function advanceJob(job: Job, deps: JobDeps): Promise<Job> {
  const now = () => (deps.now ?? (() => new Date()))();
  for (let guard = 0; guard < 8; guard++) {
    const before = job.stage;
    try {
      await step(job, deps, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const key = `error:${job.stage}`;
      if (bump(job, key) >= 3) {
        fail(
          job,
          message,
          "The provider kept failing; check its connection and credentials, then start the job again.",
          now()
        );
      } else {
        note(job, `transient error, will retry: ${message}`, now());
      }
      return job;
    }
    if (job.stage === before || job.stage === "done" || job.stage === "failed")
      return job;
  }
  return job;
}

async function step(job: Job, deps: JobDeps, now: () => Date): Promise<void> {
  switch (job.stage) {
    case "submit": {
      if (job.kind === "cloud_transfer") {
        if (!deps.transfer) {
          fail(
            job,
            "no network-drive transfer provider is configured",
            "Configure the file manager's transfer backend, then run acquire again.",
            now()
          );
          return;
        }
        const started = await deps.transfer.submit({
          source: job.transferSource!,
          destinationDir: job.filesSourceDir,
          tool: job.transferTool,
        });
        job.transferHandle = started.handle;
        note(job, "cloud transfer submitted", now());
        job.stage = "download";
        return;
      }
      if (!deps.downloads) {
        fail(
          job,
          "no downloader provider is configured",
          "Configure a downloader (qBittorrent) or start a cloud transfer job instead.",
          now()
        );
        return;
      }
      await deps.downloads.add({
        urls: [job.magnet!],
        savePath: job.savePath,
        category: job.category,
      });
      note(job, "download submitted", now());
      job.stage = "download";
      return;
    }
    case "download": {
      if (job.kind === "cloud_transfer") {
        if (!deps.transfer || !job.transferHandle) {
          fail(
            job,
            "the cloud transfer handle is missing",
            "Run acquire again to start a fresh transfer.",
            now()
          );
          return;
        }
        const status = await deps.transfer.status(job.transferHandle);
        if (status.state === "error") {
          fail(
            job,
            "the cloud transfer failed",
            `${status.message}. Check the link and the file manager's transfer log, then run acquire again.`,
            now()
          );
          return;
        }
        if (status.state === "pending") {
          note(
            job,
            `transferring${status.progress !== undefined ? ` ${Math.round(status.progress * 100)}%` : ""}`,
            now()
          );
          return;
        }
        const finishedName = status.contentName?.trim();
        if (!finishedName) {
          fail(
            job,
            "the transfer finished but its content name is unknown",
            "Copy the result into the library with files.copy, then scan the library, or re-import with the expected folder name.",
            now()
          );
          return;
        }
        job.contentName =
          finishedName.split(/[\\/]/).filter(Boolean).pop() ?? finishedName;
        note(job, `transfer finished: ${job.contentName}`, now());
        job.stage = "place";
        return;
      }
      if (!deps.downloads) {
        fail(
          job,
          "no downloader provider is configured",
          "Configure a downloader, then run acquire again.",
          now()
        );
        return;
      }
      const item = await deps.downloads.get(job.hash!);
      if (!item) {
        if (bump(job, "readd") <= MAX_ATTEMPTS.readd) {
          await deps.downloads.add({
            urls: [job.magnet!],
            savePath: job.savePath,
            category: job.category,
          });
          note(job, "download not found in the client, submitted again", now());
        } else {
          fail(
            job,
            "the download client does not know this torrent",
            "Check qBittorrent for a rejected or removed task, then run acquire again.",
            now()
          );
        }
        return;
      }
      if (item.state === "error") {
        fail(
          job,
          "the download client reports an error",
          "Check disk space and file permissions on the downloader, or choose another release.",
          now()
        );
        return;
      }
      if (item.state === "completed" || item.state === "seeding") {
        job.contentName =
          (item.contentPath ?? item.name)
            .split(/[\\/]/)
            .filter(Boolean)
            .pop() ?? item.name;
        note(job, `download finished: ${job.contentName}`, now());
        job.stage = "place";
        return;
      }
      note(
        job,
        `downloading ${Math.round(item.progress * 100)}%${item.etaSeconds !== undefined ? `, about ${Math.ceil(item.etaSeconds / 60)} min left` : ""}`,
        now()
      );
      return;
    }
    case "place": {
      const name = job.contentName!;
      const present = await exists(deps.files, job.libraryDir, name);
      if (present) {
        note(job, "files are in the library folder", now());
        job.stage = "scan";
        return;
      }
      if (job.copiedAt && now().getTime() - job.copiedAt < 20_000) return; // copy task still running
      if (bump(job, "copy") > MAX_ATTEMPTS.copy) {
        fail(
          job,
          "the files never arrived in the library folder",
          "Check the file manager's tasks and the destination's free space and write permission.",
          now()
        );
        return;
      }
      if (!(await exists(deps.files, job.filesSourceDir, name))) {
        fail(
          job,
          `the finished download is not visible at ${job.filesSourceDir}`,
          "The file manager may mount the download folder elsewhere; give the correct filesSourceDir.",
          now()
        );
        return;
      }
      await deps.files.mkdir(job.libraryDir);
      await deps.files.copy({
        sourceDir: job.filesSourceDir,
        destinationDir: job.libraryDir,
        names: [name],
      });
      job.copiedAt = now().getTime();
      note(job, `copy requested (attempt ${job.attempts.copy})`, now());
      return;
    }
    case "scan": {
      const provider = pickLibrary(deps, job.mediaServer);
      if (!provider) {
        note(job, "no media server configured; skipping scan", now());
        job.stage = "done";
        return;
      }
      await provider.scan();
      bump(job, "scan");
      note(job, `library scan requested (attempt ${job.attempts.scan})`, now());
      job.stage = "verify";
      return;
    }
    case "verify": {
      const provider = pickLibrary(deps, job.mediaServer);
      const media = provider ? deps.media?.[provider.service] : undefined;
      if (!provider || !media) {
        note(job, "media server search is unavailable; cannot verify", now());
        job.stage = "done";
        return;
      }
      const page = await media.searchItems({
        query: job.title,
        year: job.year,
        limit: 5,
      });
      const found = page.items.find(
        (item) =>
          normalise(item.title).includes(normalise(job.title)) ||
          normalise(job.title).includes(normalise(item.title))
      );
      if (found) {
        note(
          job,
          `found in ${provider.service}: ${found.title}${found.year ? ` (${found.year})` : ""} [id ${found.id}]`,
          now()
        );
        job.stage = "done";
        return;
      }
      if ((job.attempts.scan ?? 0) < MAX_ATTEMPTS.scan) {
        note(job, "not in the library yet; scanning again", now());
        job.stage = "scan";
        return;
      }
      fail(
        job,
        "the media server did not pick the item up after repeated scans",
        "Check the folder name (Title (Year)) and file names, then use library.refresh_item or rename and run acquire again.",
        now()
      );
      return;
    }
  }
}

async function exists(
  files: FilesProvider,
  dir: string,
  name: string
): Promise<boolean> {
  try {
    const listing = await files.list({ path: dir, perPage: 200 });
    return listing.entries.some((entry) => entry.name === name);
  } catch {
    return false;
  }
}

function pickLibrary(deps: JobDeps, wanted?: "emby" | "jellyfin") {
  const list = deps.libraries ?? [];
  return wanted
    ? list.find((provider) => provider.service === wanted)
    : list.length === 1
      ? list[0]
      : undefined;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Jobs survive restarts when given a store. */
export function createJobBook(deps: JobDeps, store?: JobStore) {
  const jobs = new Map<string, Job>(
    (store?.load() ?? []).map((job) => [job.id, job])
  );
  const persist = () => store?.save([...jobs.values()].slice(-50));
  // One book may be driven by a tool call and the background advancer at once;
  // serialize so a job is never stepped twice concurrently.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation, operation);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }
  return {
    acquire(spec: JobSpec): Promise<Job> {
      return serial(async () => {
        const job = createJob(spec, (deps.now ?? (() => new Date()))());
        jobs.set(job.id, job);
        await advanceJob(job, deps);
        persist();
        return job;
      });
    },
    advance(id: string): Promise<Job> {
      return serial(async () => {
        const job = jobs.get(id);
        if (!job) throw new Error(`unknown job ${id}`);
        if (job.stage === "failed") {
          job.failure = undefined;
          job.attempts = {};
          // A cloud transfer that never got a handle restarts from submit; one
          // that did can safely re-poll, since polling is idempotent.
          job.stage =
            job.kind === "cloud_transfer" && !job.transferHandle
              ? "submit"
              : "download";
        }
        await advanceJob(job, deps);
        persist();
        return job;
      });
    },
    status(id?: string): Job[] {
      return id ? (jobs.has(id) ? [jobs.get(id)!] : []) : [...jobs.values()];
    },
  };
}

export type JobBook = ReturnType<typeof createJobBook>;
