import {
  PIPELINE_TOOL_DESCRIPTIONS,
  PIPELINE_TOOL_SCHEMAS,
  type DownloadProvider,
  type FilesProvider,
  type LibraryRefreshProvider,
  type PipelineToolName,
} from "../capabilities/pipeline.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";

type Policy = ReturnType<typeof createPolicyEngine>;

export type PipelineProviders = {
  downloads?: DownloadProvider;
  files?: FilesProvider;
  libraries?: LibraryRefreshProvider[];
};

/** Names of the pipeline tools that the configured providers actually back. */
export function availablePipelineTools(providers: PipelineProviders): PipelineToolName[] {
  const names: PipelineToolName[] = [];
  if (providers.downloads) names.push("download.add", "download.list", "download.status");
  if (providers.files) names.push("files.list", "files.mkdir", "files.copy", "files.move", "files.offline_download");
  if (providers.libraries?.length) names.push("library.scan", "library.refresh_item");
  return names;
}

export function createPipelineTools(
  providers: PipelineProviders,
  options: { policy: Policy; callerId: string },
): CustomToolDefinition[] {
  return availablePipelineTools(providers).map(name => ({
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
  }));
}

async function run(name: PipelineToolName, args: Record<string, unknown>, providers: PipelineProviders): Promise<unknown> {
  switch (name) {
    case "download.add": {
      const submitted = await providers.downloads!.add({
        urls: stringArray(args.urls, "urls"),
        savePath: optionalString(args.savePath),
        category: optionalString(args.category),
        paused: args.paused === true,
      });
      return { ...submitted, note: "Submitted, not finished. Poll download.list or download.status for progress." };
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
      return (await providers.downloads!.get(requiredString(args.hash, "hash"))) ?? null;
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
      return { ...(await providers.files!.copy(transfer(args))), note: "Asynchronous. Verify with files.list." };
    case "files.move":
      return { ...(await providers.files!.move(transfer(args))), note: "Asynchronous. Verify with files.list." };
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
      return { service: provider.service, requested: true, note: "Scan is asynchronous. Verify with the media search tool." };
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

function pickLibrary(providers: PipelineProviders, requested: unknown): LibraryRefreshProvider {
  const list = providers.libraries ?? [];
  const wanted = optionalString(requested);
  const found = wanted ? list.find(provider => provider.service === wanted) : list.length === 1 ? list[0] : undefined;
  if (!found) throw new Error(wanted ? `${wanted} is not configured` : "provider is required when several media servers are configured");
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
  return value === "downloading" || value === "completed" || value === "paused" || value === "errored" || value === "all" ? value : undefined;
}

function textResult(result: unknown): { content: [{ type: "text"; text: string }]; details: Record<string, never> } {
  return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: {} };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  const items = value.flatMap(item => (typeof item === "string" && item.trim() ? [item.trim()] : []));
  if (items.length === 0) throw new Error(`${name} must not be empty`);
  return items.slice(0, 20);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}
