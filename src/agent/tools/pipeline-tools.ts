import {
  PIPELINE_TOOL_DESCRIPTIONS,
  PIPELINE_TOOL_SCHEMAS,
  type CloudTransferProvider,
  type DownloadProvider,
  type FilesProvider,
  type LibraryRefreshProvider,
  type PipelineToolName,
} from "../capabilities/pipeline.ts";
import {
  RESOURCE_SEARCH_TOOL_NAME,
  type ReleaseSearchProvider,
} from "../capabilities/pipeline.ts";
import type { MediaLibraryProvider } from "../capabilities/media.ts";
import {
  createJobBook,
  type JobBook,
  type JobStore,
} from "../pipeline/job-runner.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";

type Policy = ReturnType<typeof createPolicyEngine>;

export type PipelineProviders = {
  downloads?: DownloadProvider;
  /** Network-drive transfer backend for `kind: "cloud_transfer"` acquisition jobs. */
  transfer?: CloudTransferProvider;
  files?: FilesProvider;
  libraries?: LibraryRefreshProvider[];
  search?: ReleaseSearchProvider;
  /** Media server lookups used to verify that a finished job really landed in the library. */
  media?: Partial<Record<"emby" | "jellyfin", MediaLibraryProvider>>;
  jobStore?: JobStore;
};

const canRunJobs = (providers: PipelineProviders) =>
  !!(providers.files && (providers.downloads || providers.transfer));

/** Whether the configured providers can back the durable acquisition jobs. */
export function canRunPipelineJobs(providers: PipelineProviders): boolean {
  return canRunJobs(providers);
}

/** Names of the pipeline tools that the configured providers actually back. */
export function availablePipelineTools(
  providers: PipelineProviders
): PipelineToolName[] {
  const names: PipelineToolName[] = [];
  if (providers.downloads)
    names.push("download.add", "download.list", "download.status");
  if (providers.downloads?.pause) names.push("download.pause");
  if (providers.downloads?.resume) names.push("download.resume");
  if (providers.downloads?.remove) names.push("download.delete");
  if (providers.files)
    names.push(
      "files.list",
      "files.mkdir",
      "files.copy",
      "files.move",
      "files.offline_download"
    );
  if (providers.libraries?.length)
    names.push("library.scan", "library.refresh_item");
  return names;
}

/** Every pipeline-related tool the configured providers back, including search and jobs. */
export function allPipelineToolNames(providers: PipelineProviders): string[] {
  return [
    ...availablePipelineTools(providers),
    ...(providers.search ? [RESOURCE_SEARCH_TOOL_NAME] : []),
    ...(canRunJobs(providers)
      ? ["pipeline.acquire", "pipeline.advance", "pipeline.status"]
      : []),
  ];
}

const JOB_SCHEMAS: Record<string, Record<string, unknown>> = {
  [RESOURCE_SEARCH_TOOL_NAME]: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Title, optionally with year, e.g. 'Dune Part Two 2024'.",
      },
      type: { type: "string", enum: ["movie", "tv", "music", "any"] },
      limit: { type: "integer", minimum: 1, maximum: 30 },
    },
    required: ["query"],
  },
  "pipeline.acquire": {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["torrent", "cloud_transfer"],
        description: "How the content arrives. Omit for a torrent.",
      },
      title: {
        type: "string",
        description: "Title to look for in the media server afterwards.",
      },
      year: { type: "integer" },
      magnet: {
        type: "string",
        description:
          "torrent: magnet: link of the release the user chose (needs a btih info-hash).",
      },
      transferSource: {
        type: "string",
        description:
          "cloud_transfer: share or direct link the file manager's transfer backend fetches.",
      },
      transferTool: {
        type: "string",
        description:
          "cloud_transfer: provider-side downloader name, e.g. 115 Cloud.",
      },
      savePath: {
        type: "string",
        description: "Downloader-side save directory.",
      },
      category: { type: "string" },
      filesSourceDir: {
        type: "string",
        description:
          "Where the downloader's output appears in the file manager.",
      },
      libraryDir: {
        type: "string",
        description: "Folder the media server watches, e.g. /media/Movies.",
      },
      mediaServer: { type: "string", enum: ["emby", "jellyfin"] },
    },
    required: ["title", "filesSourceDir", "libraryDir"],
  },
  "pipeline.advance": {
    type: "object",
    properties: { jobId: { type: "string" } },
    required: ["jobId"],
  },
  "pipeline.status": {
    type: "object",
    properties: {
      jobId: { type: "string", description: "Omit to list all jobs." },
    },
  },
};

const JOB_DESCRIPTIONS: Record<string, string> = {
  [RESOURCE_SEARCH_TOOL_NAME]:
    "Search torrent indexers (Prowlarr) for a title. Returns ranked releases with size, seeders, quality and a downloadUrl. Search never downloads; show the best few to the user and let them choose.",
  "pipeline.acquire":
    "Start a deterministic acquisition job for the chosen release: download (or transfer the chosen share from the network drive), copy into the library folder, scan the media server and verify the item appears. Requires approval once for the whole plan. The job advances itself with fixed, bounded retries; call pipeline.advance to move it forward and pipeline.status to inspect it.",
  "pipeline.advance":
    "Advance a job by performing whatever step is possible now (never blocks). Call it repeatedly until stage is done or failed. A failed job carries a reason and advice; fix the cause, then advance again to resume.",
  "pipeline.status":
    "Show jobs, their stage, attempt counts, log and any failure advice. Read-only.",
};

export function createPipelineTools(
  providers: PipelineProviders,
  options: {
    policy: Policy;
    callerId: string;
    /** Shared book so the background advancer and the tools step one job set. */
    book?: JobBook;
    /** Called when a job is acquired, so the advancer can keep it moving. */
    onAcquired?: (jobId: string) => void;
  }
): CustomToolDefinition[] {
  const book =
    options.book ??
    (canRunJobs(providers)
      ? createJobBook(
          {
            downloads: providers.downloads,
            transfer: providers.transfer,
            files: providers.files!,
            libraries: providers.libraries,
            media: providers.media,
          },
          providers.jobStore
        )
      : undefined);
  const extra: CustomToolDefinition[] = [];
  const define = (
    name: string,
    run: (args: Record<string, unknown>) => Promise<unknown> | unknown
  ) =>
    extra.push({
      name,
      label: name,
      description: JOB_DESCRIPTIONS[name]!,
      parameters: JOB_SCHEMAS[name],
      execute: async (_id: string, params: unknown) => {
        const decision = options.policy.allow(name, options.callerId);
        if (!decision.ok) throw new Error(decision.reason);
        return textResult(await run(asObject(params)));
      },
    });
  if (providers.search) {
    define(RESOURCE_SEARCH_TOOL_NAME, async (args) => ({
      releases: await providers.search!.search({
        query: requiredString(args.query, "query"),
        type:
          args.type === "movie" || args.type === "tv" || args.type === "music"
            ? args.type
            : "any",
        limit: integer(args.limit),
      }),
    }));
  }
  if (book) {
    define("pipeline.acquire", async (args) => {
      const job = await book.acquire({
        kind:
          args.kind === "cloud_transfer"
            ? "cloud_transfer"
            : args.kind === "torrent"
              ? "torrent"
              : undefined,
        title: requiredString(args.title, "title"),
        year: integer(args.year),
        magnet: optionalString(args.magnet),
        transferSource: optionalString(args.transferSource),
        transferTool: optionalString(args.transferTool),
        savePath: optionalString(args.savePath),
        category: optionalString(args.category),
        filesSourceDir: requiredString(args.filesSourceDir, "filesSourceDir"),
        libraryDir: requiredString(args.libraryDir, "libraryDir"),
        mediaServer:
          args.mediaServer === "emby" || args.mediaServer === "jellyfin"
            ? args.mediaServer
            : undefined,
      });
      options.onAcquired?.(job.id);
      return view(job);
    });
    define("pipeline.advance", async (args) =>
      view(await book.advance(requiredString(args.jobId, "jobId")))
    );
    define("pipeline.status", (args) => ({
      jobs: book.status(optionalString(args.jobId)).map(view),
    }));
  }
  return [
    ...extra,
    ...availablePipelineTools(providers).map((name) => ({
      name,
      label: name,
      description: PIPELINE_TOOL_DESCRIPTIONS[name],
      parameters: PIPELINE_TOOL_SCHEMAS[name],
      execute: async (_toolCallId: string, params: unknown) => {
        const decision = options.policy.allow(name, options.callerId);
        if (!decision.ok) throw new Error(decision.reason);
        const args = asObject(params);
        return textResult(await run(name, args, providers));
      },
    })),
  ];
}

function view(job: import("../pipeline/job-runner.ts").Job) {
  return {
    jobId: job.id,
    kind: job.kind,
    title: job.title,
    stage: job.stage,
    failure: job.failure,
    attempts: job.attempts,
    recent: job.log.slice(-6),
    next:
      job.stage === "done"
        ? "Finished. Report the result."
        : job.stage === "failed"
          ? "Fix the cause in failure.advice, then call pipeline.advance."
          : "Call pipeline.advance later to continue.",
  };
}

async function run(
  name: PipelineToolName,
  args: Record<string, unknown>,
  providers: PipelineProviders
): Promise<unknown> {
  switch (name) {
    case "download.add": {
      const submitted = await providers.downloads!.add({
        urls: stringArray(args.urls, "urls"),
        savePath: optionalString(args.savePath),
        category: optionalString(args.category),
        paused: args.paused === true,
      });
      return {
        ...submitted,
        note: "Submitted, not finished. Poll download.list or download.status for progress.",
      };
    }
    case "download.pause":
    case "download.resume": {
      const hashes = stringArray(args.hashes, "hashes");
      const verb = name === "download.pause" ? "pause" : "resume";
      await providers.downloads![verb]!(hashes);
      return {
        requested: hashes.length,
        hashes,
        note: `Requested ${verb}. Confirm with download.status.`,
      };
    }
    case "download.delete": {
      const hashes = stringArray(args.hashes, "hashes");
      if (typeof args.deleteFiles !== "boolean")
        throw new Error("deleteFiles must be stated as true or false");
      await providers.downloads!.remove!(hashes, args.deleteFiles);
      return {
        requested: hashes.length,
        hashes,
        deleteFiles: args.deleteFiles,
        note: "Requested removal. Confirm with download.list.",
      };
    }
    case "download.list":
      return {
        downloads: await providers.downloads!.list({
          filter: filter(args.filter),
          category: optionalString(args.category),
          limit: integer(args.limit),
        }),
      };
    case "download.status":
      return (
        (await providers.downloads!.get(requiredString(args.hash, "hash"))) ??
        null
      );
    case "files.list":
      return providers.files!.list({
        path: requiredString(args.path, "path"),
        page: integer(args.page),
        perPage: integer(args.perPage),
      });
    case "files.mkdir":
      await providers.files!.mkdir(requiredString(args.path, "path"));
      return { created: true };
    case "files.copy":
      return {
        ...(await providers.files!.copy(transfer(args))),
        note: "Asynchronous. Verify with files.list.",
      };
    case "files.move":
      return {
        ...(await providers.files!.move(transfer(args))),
        note: "Asynchronous. Verify with files.list.",
      };
    case "files.offline_download":
      return {
        ...(await providers.files!.offlineDownload({
          urls: stringArray(args.urls, "urls"),
          destinationDir: requiredString(args.destinationDir, "destinationDir"),
          tool: optionalString(args.tool),
        })),
        note: "Asynchronous. Verify with files.list.",
      };
    case "library.scan": {
      const provider = pickLibrary(providers, args.provider);
      await provider.scan();
      return {
        service: provider.service,
        requested: true,
        note: "Scan is asynchronous. Verify with the media search tool.",
      };
    }
    case "library.refresh_item": {
      const provider = pickLibrary(providers, args.provider);
      await provider.refreshItem({
        id: requiredString(args.id, "id"),
        replaceAllMetadata: args.replaceAllMetadata === true,
        replaceAllImages: args.replaceAllImages === true,
      });
      return { service: provider.service, requested: true };
    }
  }
}

function pickLibrary(
  providers: PipelineProviders,
  requested: unknown
): LibraryRefreshProvider {
  const list = providers.libraries ?? [];
  const wanted = optionalString(requested);
  const found = wanted
    ? list.find((provider) => provider.service === wanted)
    : list.length === 1
      ? list[0]
      : undefined;
  if (!found)
    throw new Error(
      wanted
        ? `${wanted} is not configured`
        : "provider is required when several media servers are configured"
    );
  return found;
}

function transfer(args: Record<string, unknown>) {
  return {
    sourceDir: requiredString(args.sourceDir, "sourceDir"),
    destinationDir: requiredString(args.destinationDir, "destinationDir"),
    names: stringArray(args.names, "names"),
  };
}

function filter(value: unknown) {
  return value === "downloading" ||
    value === "completed" ||
    value === "paused" ||
    value === "errored" ||
    value === "all"
    ? value
    : undefined;
}

function textResult(result: unknown): {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    details: {},
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be a list`);
  const items = value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
  if (items.length === 0) throw new Error(`${name} must not be empty`);
  return items.slice(0, 20);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}
