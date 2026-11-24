import { randomUUID } from "node:crypto";
import type {
  CloudTransferProvider,
  DownloadProvider,
  FilesProvider,
  LibraryRefreshProvider,
} from "../capabilities/pipeline.ts";
import type { MediaLibraryProvider } from "../capabilities/media.ts";
import { join } from "node:path/posix";
import { httpError } from "../types.ts";

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
  ticketId?: string;
  placementSkill?: PlacementSkill;
  placement?: Placement;
  attempts: Record<string, number>;
  copiedAt?: number;
  log: Array<{ at: string; stage: JobStage; message: string }>;
  failure?: { stage: JobStage; reason: string; advice: string };
  createdAt: string;
  updatedAt: string;
};

export type Placement = {
  id: string;
  source: string;
  destination: string;
  digest: string;
  state: "pending" | "denied" | "dispatching" | "verified" | "uncertain";
  decidedAt?: string;
  dispatchedAt?: string;
  verifiedAt?: string;
  verification?: "sha256";
  stoppedAt?: string;
  skill?: PlacementSkill;
};

export type PlacementSkill = { name: string; digest: string };
export type PlacementContext = { ticketId: string; skill: PlacementSkill };

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
  saveStrict?(jobs: Job[]): void;
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
            "Copy the result into the library with files_copy, then scan the library, or re-import with the expected folder name.",
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
      if (job.ticketId) {
        if (!job.placement) {
          if (
            !name ||
            name === "." ||
            name === ".." ||
            /[\\/]/.test(name) ||
            ![job.filesSourceDir, job.libraryDir].every(
              (path) =>
                path === path.trim() &&
                path.startsWith("/") &&
                !path.split("/").includes("..")
            )
          ) {
            fail(
              job,
              "Placement requires absolute directories and one file name",
              "Use absolute source and library directories without parent traversal.",
              now()
            );
            return;
          }
          const source = await findFile(deps.files, job.filesSourceDir, name);
          const digest = fileDigest(source);
          if (!digest) {
            fail(
              job,
              "Source file identity is unavailable",
              "Use a single file on a provider that reports its SHA-256 digest.",
              now()
            );
            return;
          }
          job.placement = {
            id: randomUUID(),
            source: join(job.filesSourceDir, name),
            destination: join(job.libraryDir, name),
            digest,
            skill: job.placementSkill,
            state: "pending",
          };
        }
        return;
      }
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
        "Check the folder name (Title (Year)) and file names, then use library_refresh_item or rename and run acquire again.",
        now()
      );
      return;
    }
  }
}

async function findFile(files: FilesProvider, path: string, name: string) {
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const listing = await files.list({ path, page, perPage, refresh: true });
    const found = listing.entries.find((entry) => entry.name === name);
    if (
      found ||
      page * perPage >= listing.total ||
      listing.entries.length === 0
    )
      return found;
  }
}

function fileDigest(
  file: Awaited<ReturnType<typeof findFile>>
): string | undefined {
  const digest = file?.sha256;
  return !file?.isDirectory && digest && /^[a-f0-9]{64}$/i.test(digest)
    ? digest.toLowerCase()
    : undefined;
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
  const persist = () => {
    const all = [...jobs.values()];
    store?.save([
      ...all.filter((job) => job.ticketId),
      ...all.filter((job) => !job.ticketId).slice(-50),
    ]);
  };
  const savePlacement = () => {
    if (!store?.saveStrict)
      throw httpError(
        503,
        "Placement requires durable job storage",
        "placement_store_unavailable"
      );
    store.saveStrict([...jobs.values()]);
  };
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
  function saveTransition(job: Job, next: Placement): void {
    const previous = job.placement;
    job.placement = previous?.stoppedAt
      ? { ...next, stoppedAt: previous.stoppedAt }
      : next;
    try {
      savePlacement();
    } catch (error) {
      job.placement = previous;
      throw error;
    }
  }
  return {
    stopPlacements(ticketId: string): boolean {
      const jobsForTicket = [...jobs.values()].filter(
        (job) =>
          job.ticketId === ticketId &&
          job.placement &&
          (job.placement.stoppedAt ||
            (job.stage !== "done" && job.stage !== "failed"))
      );
      if (!jobsForTicket.length) return false;
      const at = (deps.now ?? (() => new Date()))().toISOString();
      const previous = jobsForTicket.map((job) => job.placement!);
      for (const job of jobsForTicket) {
        job.placement = {
          ...job.placement!,
          stoppedAt: job.placement!.stoppedAt ?? at,
        };
      }
      try {
        savePlacement();
      } catch (error) {
        jobsForTicket.forEach((job, index) => {
          job.placement = previous[index];
        });
        throw error;
      }
      return true;
    },
    recoverPlacements(): Promise<void> {
      return serial(async () => {
        for (const job of jobs.values()) {
          const placement = job.placement;
          if (!job.ticketId || placement?.state !== "dispatching") continue;
          await verifyPlacement(job, placement);
          if (job.placement?.state === "dispatching") {
            saveTransition(job, { ...placement, state: "uncertain" });
          }
        }
      });
    },
    decidePlacement(input: {
      ticketId: string;
      placementId: string;
      decision: "allow" | "deny";
      authorize: () => Promise<void>;
    }): Promise<string> {
      return serial(async () => {
        const job = [...jobs.values()].find(
          (row) =>
            row.ticketId === input.ticketId &&
            row.placement?.id === input.placementId
        );
        const placement = job?.placement;
        if (!job || placement?.state !== "pending" || placement.stoppedAt) {
          throw httpError(
            409,
            "Placement approval is no longer pending",
            "placement_stale"
          );
        }
        const now = deps.now ?? (() => new Date());
        if (input.decision === "deny") {
          saveTransition(job, {
            ...placement,
            state: "denied",
            decidedAt: now().toISOString(),
          });
          return job.id;
        }
        const name = job.contentName!;
        const source = await findFile(deps.files, job.filesSourceDir, name);
        if (
          fileDigest(source) !== placement.digest ||
          join(job.filesSourceDir, name) !== placement.source ||
          join(job.libraryDir, name) !== placement.destination
        ) {
          throw httpError(
            409,
            "The approved file or destination changed",
            "placement_changed"
          );
        }
        if (await findFile(deps.files, job.libraryDir, name)) {
          throw httpError(
            409,
            "A file already exists at the destination",
            "placement_destination_exists"
          );
        }
        await input.authorize();
        if (job.placement?.stoppedAt) {
          throw httpError(409, "Placement has been stopped", "ticket_stopped");
        }
        const at = now().toISOString();
        const dispatched = {
          ...placement,
          state: "dispatching" as const,
          decidedAt: at,
          dispatchedAt: at,
        };
        saveTransition(job, dispatched);
        try {
          await deps.files.copy({
            sourceDir: job.filesSourceDir,
            destinationDir: job.libraryDir,
            names: [name],
          });
        } catch {
          saveTransition(job, { ...dispatched, state: "uncertain" });
          return job.id;
        }
        await verifyPlacement(job, dispatched);
        return job.id;
      });
    },
    acquire(spec: JobSpec, placement?: PlacementContext): Promise<Job> {
      return serial(async () => {
        const job = createJob(spec, (deps.now ?? (() => new Date()))());
        const ticketId = placement?.ticketId;
        if (ticketId && !store?.saveStrict)
          throw httpError(
            503,
            "Placement requires durable job storage",
            "placement_store_unavailable"
          );
        if (placement) {
          job.ticketId = placement.ticketId;
          job.placementSkill = placement.skill;
        }
        await advanceJob(job, deps);
        jobs.set(job.id, job);
        if (ticketId) {
          try {
            savePlacement();
          } catch (error) {
            jobs.delete(job.id);
            throw error;
          }
        } else persist();
        return job;
      });
    },
    advance(id: string): Promise<Job> {
      return serial(async () => {
        const previous = jobs.get(id);
        if (!previous) throw new Error(`unknown job ${id}`);
        // A copy in progress only receives read-back checks. It cannot dispatch from advance.
        if (previous.placement?.state === "dispatching") {
          await verifyPlacement(previous, previous.placement);
          return previous;
        }
        if (previous.placement?.stoppedAt) return previous;
        const job = previous.ticketId ? structuredClone(previous) : previous;
        if (job.stage === "failed" && !job.placement) {
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
        if (previous.placement?.stoppedAt) return previous;
        if (job.ticketId) {
          jobs.set(id, job);
          try {
            savePlacement();
          } catch (error) {
            jobs.set(id, previous);
            throw error;
          }
        } else persist();
        return job;
      });
    },
    status(id?: string): Job[] {
      return id ? (jobs.has(id) ? [jobs.get(id)!] : []) : [...jobs.values()];
    },
  };

  async function verifyPlacement(
    job: Job,
    placement: Placement
  ): Promise<void> {
    let destination;
    try {
      destination = await findFile(
        deps.files,
        job.libraryDir,
        job.contentName!
      );
    } catch {
      // Read-back may be temporarily unavailable while the provider copies.
      return;
    }
    if (!destination) return;
    if (fileDigest(destination) !== placement.digest) {
      saveTransition(job, { ...placement, state: "uncertain" });
      return;
    }
    const now = deps.now ?? (() => new Date());
    const before = job.stage;
    job.stage = "scan";
    try {
      saveTransition(job, {
        ...placement,
        state: "verified",
        verifiedAt: now().toISOString(),
        verification: "sha256",
      });
    } catch (error) {
      job.stage = before;
      throw error;
    }
  }
}

export type JobBook = ReturnType<typeof createJobBook>;
