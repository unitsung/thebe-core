import { parsePermissionMode } from "../agent/runtime/interface.ts";
import { shellParserReady } from "../agent/security/shell-parse.ts";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArcaneAdapter } from "../adapters/arcane/adapter.ts";
import { createDockerEngineProviderFromEnv } from "../adapters/docker/adapter.ts";
import { createNavidromeProviderFromEnv } from "../adapters/navidrome/index.ts";
import { createMusicResearchProvider } from "../adapters/music-research/client.ts";
import { createWebSearchProvider } from "../adapters/web-search/client.ts";
import { createServiceAPIProvidersFromEnv } from "../adapters/service-api/client.ts";
import { createQBittorrentDownloadProviderFromEnv } from "../adapters/pipeline/qbittorrent-downloads.ts";
import { createOpenListFilesProviderFromEnv } from "../adapters/pipeline/openlist-files.ts";
import { createOpenListTransferProviderFromEnv } from "../adapters/pipeline/openlist-transfer.ts";
import { createFileJobStore } from "../agent/pipeline/job-store.ts";
import { createProwlarrSearchProviderFromEnv } from "../adapters/pipeline/prowlarr-search.ts";
import { createLibraryRefreshProvidersFromEnv } from "../adapters/pipeline/library-refresh.ts";
import { createEmbyProviderFromEnv } from "../adapters/emby/env.ts";
import { createJellyfinProviderFromEnv } from "../adapters/jellyfin/env.ts";
import { createImmichProviderFromEnv } from "../adapters/immich/env.ts";
import {
  arcaneEnvironmentIdFromEnv,
  createArcaneBackgroundTaskProviderFromEnv,
} from "../adapters/arcane/tasks.ts";
import { applyThebeApiKey } from "./auth.ts";
import { envLocalCandidates, loadEnvLocal } from "./config/env.ts";
import { resolveThebeToken } from "../delivery/http/bind.ts";
import { createTokenVerifier } from "../delivery/http/token-store.ts";
import { createThebeApp } from "./create.ts";
import type { ThebeAgent } from "../agent/interface.ts";
import type { ContainerInfoProvider } from "../agent/capabilities/containers.ts";
import { createPiCodingAgentRuntime } from "../adapters/pi/runtime.ts";
import type { AgentRuntime } from "../agent/runtime/interface.ts";
import { loadThebeUserConfig } from "../adapters/pi/config/user-config.ts";
import { createJevAdapter } from "../adapters/jev/adapter.ts";
import {
  createOpenListBackgroundTaskProviderFromEnv,
  createOpenListStrmRepairProviderFromEnv,
} from "../adapters/openlist/index.ts";
import { createQBittorrentBackgroundTaskProviderFromEnv } from "../adapters/qbittorrent/tasks.ts";
import { readJudgmentGate } from "../agent/judgment/gate.ts";
import { createJsonAgentSettingsStore } from "../agent/settings/store.ts";
import { createJsonMemoryStore } from "../agent/memory/store.ts";

export type ThebeBootstrap = {
  runtime: AgentRuntime;
  agent: ThebeAgent;
  prompt: (text: string) => Promise<{ text: string; tools: string[] }>;
  send: (text: string) => Promise<{ text: string; tools: string[] }>;
  handler: ReturnType<typeof createThebeApp>["handler"];
  version: string;
  model?: { providerId: string; modelId: string };
  workspacePath: string;
  outputDirectory: string;
  /** Shared token for HTTP clients; generated and persisted when unset. */
  token: string;
  tokenGenerated: boolean;
  tokenPath?: string;
};

export type BootstrapOptions = {
  fromDir?: string;
  requireArcane?: boolean;
  model?: { providerId: string; modelId: string };
  allowedHosts?: string[];
};

/**
 * Shared factory for serve / CLI / TUI. Loads `.env.local`, embeds Pi via
 * AgentRuntime, and returns a agent service — never spawns the Pi CLI.
 */
export async function bootstrapThebe(
  options?: BootstrapOptions
): Promise<ThebeBootstrap> {
  const fromDir = options?.fromDir ?? dirname(fileURLToPath(import.meta.url));
  loadEnvLocal(fromDir);
  // The command guard reads scripts as shell; without the grammar it falls back to its text rules.
  await shellParserReady().catch((error: unknown) => {
    console.error(`Command guard: shell parser unavailable (${String(error)}); using text rules only.`);
  });
  const userConfig = loadThebeUserConfig();
  const configuredWorkspacePath =
    userConfig.workspacePath?.trim() || process.env.THEBE_WORKSPACE_DIR?.trim();
  if (!configuredWorkspacePath) {
    throw new Error(
      "Thebe workspace is not configured. Set workspacePath in ~/.thebe/config.json or THEBE_WORKSPACE_DIR before starting Thebe."
    );
  }
  const configDir = resolve(
    process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe")
  );
  const tokenResolution = resolveThebeToken({ configDir });
  const resolveConfiguredPath = (path: string): string =>
    isAbsolute(path) ? resolve(path) : resolve(configDir, path);
  const workspacePath = resolveConfiguredPath(configuredWorkspacePath);
  const outputDirectoryValue =
    userConfig.outputDirectory?.trim() || process.env.THEBE_OUTPUT_DIR?.trim();
  const outputDirectory = outputDirectoryValue
    ? resolveConfiguredPath(outputDirectoryValue)
    : join(workspacePath, ".thebe", "outputs");

  const requireArcane = options?.requireArcane ?? false;
  const baseUrl = process.env.ARCANE_BASE_URL;
  const arcaneKey = process.env.ARCANE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (requireArcane && (!baseUrl || !arcaneKey)) {
    failEnv("Missing ARCANE_BASE_URL or ARCANE_API_KEY", fromDir);
  }

  let defaultModel = options?.model;
  let primaryApiKey: { providerId: string; key: string } | undefined;

  if (openaiKey) {
    primaryApiKey = { providerId: "openai", key: openaiKey };
    defaultModel ??= { providerId: "openai", modelId: "gpt-4o" };
  } else if (anthropicKey) {
    primaryApiKey = { providerId: "anthropic", key: anthropicKey };
    defaultModel ??= { providerId: "anthropic", modelId: "claude-sonnet-4" };
  }

  const agentDir =
    process.env.THEBE_AGENT_DIR ??
    join(process.env.HOME ?? ".", ".thebe", "agent");

  const sessionDir =
    process.env.THEBE_SESSION_DIR ??
    join(process.env.HOME ?? ".", ".thebe", "sessions");

  const runtime = await createPiCodingAgentRuntime({
    cwd: workspacePath,
    sessionDir,
    agentDir,
    apiKey: primaryApiKey,
    model: defaultModel,
  });

  if (openaiKey) {
    await applyThebeApiKey(runtime.auth(), "openai", openaiKey);
  }
  if (anthropicKey) {
    await applyThebeApiKey(runtime.auth(), "anthropic", anthropicKey);
  }
  if (!defaultModel) {
    const available = await runtime.listAvailableModels();
    const selected = available[0];
    if (selected)
      defaultModel = {
        providerId: selected.providerId,
        modelId: selected.modelId,
      };
  }

  const arcaneEnvironmentId = arcaneEnvironmentIdFromEnv();
  // Container panel first; the Docker Engine API through a restricted proxy is
  // the Arcane-free fallback.
  const dockerEngineProvider = createDockerEngineProviderFromEnv();
  const provider: ContainerInfoProvider =
    baseUrl && arcaneKey
      ? new ArcaneAdapter({
          baseUrl,
          apiKey: arcaneKey,
          ...(arcaneEnvironmentId
            ? { environmentId: arcaneEnvironmentId }
            : {}),
        })
      : (dockerEngineProvider ?? stubProvider());
  const strmRepairProvider = createOpenListStrmRepairProviderFromEnv();
  const navidrome = createNavidromeProviderFromEnv();
  const emby = createEmbyProviderFromEnv();
  const jellyfin = createJellyfinProviderFromEnv();
  const immich = createImmichProviderFromEnv();
  const openListBackgroundTaskProvider =
    createOpenListBackgroundTaskProviderFromEnv();
  const arcaneBackgroundTaskProvider =
    createArcaneBackgroundTaskProviderFromEnv();

  const version = readPackageVersion(fromDir);
  const agentStoreDir =
    process.env.THEBE_AGENT_STORE_DIR ??
    join(process.env.HOME ?? ".", ".thebe", "sessions");

  const judgmentGate = readJudgmentGate();
  const judgment =
    judgmentGate.adapter === "jev"
      ? createJevAdapter({
          apiKey: judgmentGate.apiKey,
          baseUrl: judgmentGate.baseUrl,
          model: judgmentGate.model,
        })
      : undefined;
  const judgmentSites =
    judgmentGate.adapter === "jev" ? judgmentGate.sites : undefined;

  const app = createThebeApp({
    runtime,
    provider,
    version,
    // The token file, `THEBE_TOKEN` and the per-device tokens are read as they change, so
    // `thebe token` commands apply without a restart.
    token: createTokenVerifier({ configDir, fallback: tokenResolution.token }),
    agentStoreDir,
    auditPath: process.env.THEBE_AUDIT_PATH,
    model: defaultModel,
    autoCompact: userConfig.autoCompact,
    autoSummary: userConfig.autoSummary,
    autoSummaryDelayMs: userConfig.autoSummaryDelayMs,
    permissionMode: parsePermissionMode(userConfig.permissionMode),
    maxSubagentConcurrency: userConfig.maxSubagentConcurrency,
    maxSubagentsPerParent: userConfig.maxSubagentsPerParent,
    workspacePath,
    outputDirectory,
    allowedHosts: options?.allowedHosts,
    judgment,
    judgmentSites,
    settingsStore: createJsonAgentSettingsStore(join(configDir, "config.json")),
    memoryStore: createJsonMemoryStore(join(configDir, "memory.json")),
    strmRepairProvider,
    navidrome,
    pipeline: {
      downloads: createQBittorrentDownloadProviderFromEnv(),
      transfer: createOpenListTransferProviderFromEnv(),
      files: createOpenListFilesProviderFromEnv(),
      libraries: createLibraryRefreshProvidersFromEnv(),
      search: createProwlarrSearchProviderFromEnv(),
      media: { ...(emby ? { emby } : {}), ...(jellyfin ? { jellyfin } : {}) },
      jobStore: createFileJobStore(join(agentStoreDir, "pipeline-jobs.json")),
    },
    musicResearch: createMusicResearchProvider(),
    webSearch: process.env.THEBE_WEB_SEARCH_URL?.trim()
      ? createWebSearchProvider({ endpoint: process.env.THEBE_WEB_SEARCH_URL })
      : undefined,
    emby,
    jellyfin,
    immich,
    serviceAPIProviders: createServiceAPIProvidersFromEnv(),
    backgroundTaskProviders: [
      ...(() => {
        const provider = createQBittorrentBackgroundTaskProviderFromEnv();
        return provider ? [provider] : [];
      })(),
      ...(arcaneBackgroundTaskProvider ? [arcaneBackgroundTaskProvider] : []),
      ...(openListBackgroundTaskProvider
        ? [openListBackgroundTaskProvider]
        : []),
    ],
  });

  return {
    runtime,
    agent: app.agent,
    prompt: app.prompt,
    send: app.send,
    handler: app.handler,
    version,
    model: defaultModel,
    workspacePath,
    outputDirectory,
    token: tokenResolution.token,
    tokenGenerated: tokenResolution.generated,
    tokenPath: tokenResolution.path,
  };
}

function failEnv(message: string, fromDir: string): never {
  console.error(message);
  console.error("Put them in .env.local. Looked in:");
  for (const path of envLocalCandidates(fromDir)) {
    console.error(`  ${path}`);
  }
  process.exit(1);
}

function stubProvider(): ContainerInfoProvider {
  const notConfigured =
    "No container provider is configured (set ARCANE_BASE_URL/ARCANE_API_KEY, or THEBE_DOCKER_PROXY_URL for the Docker Engine API)";
  return {
    async listContainers() {
      return [];
    },
    async inspectContainer() {
      throw new Error(notConfigured);
    },
    async getContainerLogs() {
      throw new Error(notConfigured);
    },
    async getStatusSummary() {
      return {
        totalContainers: 0,
        runningContainers: 0,
        pausedContainers: 0,
        exitedContainers: 0,
        lastUpdated: Date.now(),
      };
    },
  };
}

function readPackageVersion(fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8")
      ) as { version?: string };
      if (parsed.version) {
        return parsed.version;
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "0.1.0";
}
