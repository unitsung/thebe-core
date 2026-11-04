import { join } from "node:path";
import type { ContainerInfoProvider } from "../agent/capabilities/containers.ts";
import type { ServiceAPIProvider } from "../agent/capabilities/service-api.ts";
import type { NavidromeProvider } from "../agent/capabilities/navidrome.ts";
import type { PipelineProviders } from "../agent/tools/pipeline-tools.ts";
import type { MusicResearchProvider } from "../agent/capabilities/music-research.ts";
import type { MusicSourcesProvider } from "../agent/capabilities/music-sources.ts";
import type { WebSearchProvider } from "../agent/capabilities/web-search.ts";
import type {
  MediaLibraryProvider,
  PhotoLibraryProvider,
} from "../agent/capabilities/media.ts";
import type { AgentRuntime } from "../agent/runtime/interface.ts";
import { resolveAllowedHosts } from "../delivery/http/bind.ts";
import {
  createThebeHttpHandler,
  type ThebeHttpHandlerOptions,
} from "../delivery/http/handler.ts";
import {
  createRateLimiter,
  type RateLimit,
} from "../delivery/http/rate-limit.ts";
import { createDeviceRegistry } from "../delivery/http/devices.ts";
import { createPushIdentity } from "./push/identity.ts";
import { createPushNotifier } from "./push/notifier.ts";
import {
  createThebeAgent,
  type CreateThebeAgentOptions,
  type ThebeAgent,
} from "../agent/index.ts";
import { createMcpClientRegistry } from "../adapters/mcp/index.ts";
import type { McpRegistry } from "../agent/extensions/mcp.ts";
import type { AgentSettingsStore } from "../agent/settings/product.ts";
import type { AgentMemoryStore } from "../agent/memory/store.ts";
import type { ArtifactStore } from "../agent/artifacts/store.ts";
import type { StrmRepairProvider } from "../agent/capabilities/strm.ts";
import type { ProductBackgroundTaskProvider } from "../agent/background-tasks/product.ts";

export type ThebeAppPrompt = (
  text: string
) => Promise<{ text: string; tools: string[] }>;

/** @deprecated Use ThebeAppPrompt */
export type ThebeAppSend = ThebeAppPrompt;

export type McpListenerHandlerOptions = {
  rateLimit?: RateLimit;
  allowedHosts?: string[];
};

export function createThebeApp(options: {
  runtime: AgentRuntime;
  provider: ContainerInfoProvider;
  version?: string;
  token?:
    | string
    | import("../delivery/http/token-store.ts").TokenSource
    | import("../delivery/http/token-store.ts").TokenVerifier;
  auditPath?: string;
  agentStoreDir?: string;
  /** The Push Relay events are sent to. Unset: Core registers devices but sends no push. */
  pushRelayUrl?: string;
  /** Replaces `fetch` for calls to the Push Relay; tests use it to stand in for the relay. */
  pushFetch?: typeof fetch;
  now?: () => Date;
  /** Event sources: `evaluate` for Triggers past the Gate; `timer` and `pollIntervalMs` for the poll loop. */
  sources?: CreateThebeAgentOptions["sources"];
  /** Tests replace the scheduler's loop with a tick they call by hand. */
  schedules?: CreateThebeAgentOptions["schedules"];
  callerId?: string;
  model?: import("../agent/runtime/interface.ts").RuntimeModelRef;
  allowedHosts?: string[];
  sessionIdleTimeoutMs?: number;
  modelResultLimit?: number;
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  permissionMode?: import("../agent/runtime/interface.ts").PermissionMode;
  fullAccessAllowed?: boolean;
  remoteBashAllowed?: boolean;
  mcpWritesAllowed?: boolean;
  mcpIrreversibleAllowed?: boolean;
  maxSubagentConcurrency?: number;
  maxSubagentsPerParent?: number;
  workspacePath?: string;
  outputDirectory?: string;
  settingsStore?: AgentSettingsStore;
  memoryStore?: AgentMemoryStore;
  mcp?: McpRegistry;
  artifactStore?: ArtifactStore;
  strmRepairProvider?: StrmRepairProvider;
  navidrome?: NavidromeProvider;
  pipeline?: PipelineProviders;
  musicResearch?: MusicResearchProvider;
  musicSources?: MusicSourcesProvider;
  webSearch?: WebSearchProvider;
  emby?: MediaLibraryProvider;
  jellyfin?: MediaLibraryProvider;
  immich?: PhotoLibraryProvider;
  backgroundTaskProviders?: readonly ProductBackgroundTaskProvider[];
  serviceAPIProviders?: readonly ServiceAPIProvider[];
}): {
  agent: ThebeAgent;
  prompt: ThebeAppPrompt;
  send: ThebeAppSend;
  handler: ReturnType<typeof createThebeHttpHandler>;
  /**
   * A handler for the second listener that serves only `/mcp`, with the same agent, tokens and Host
   * check. With `rateLimit`, each token gets that many requests per window and then an immediate 429.
   */
  createMcpHandler: (
    options?: McpListenerHandlerOptions
  ) => ReturnType<typeof createThebeHttpHandler>;
} {
  const storedSettings = options.settingsStore?.load();
  const deviceDir = options.agentStoreDir
    ? join(options.agentStoreDir, "devices")
    : undefined;
  const deviceRegistry = createDeviceRegistry({ dir: deviceDir });
  const relayUrl = options.pushRelayUrl?.trim();
  const pushIdentity = relayUrl
    ? createPushIdentity({ dir: deviceDir })
    : undefined;
  const pushNotifier =
    relayUrl && pushIdentity
      ? createPushNotifier({
          relayUrl,
          identity: pushIdentity,
          devices: deviceRegistry,
          dir: deviceDir,
          fetch: options.pushFetch,
          now: options.now,
        })
      : undefined;
  const agent = createThebeAgent({
    onPendingApproval: pushNotifier
      ? (record) => {
          void pushNotifier.notify({
            category: "thebe.permission",
            title: "Thebe",
            body: "An action is waiting for your approval.",
            deepLink: `thebe://approval/${encodeURIComponent(record.id)}`,
            id: `approval-${record.id}`,
          });
        }
      : undefined,
    onGoalAttention: pushNotifier
      ? (attention) => {
          // One notice per question: the id is keyed by goal and ask time, so a repeat is dropped.
          void pushNotifier.notify({
            category: "thebe.activity",
            title: "Thebe",
            body: "A task has a question for you.",
            deepLink: `thebe://goal/${encodeURIComponent(attention.goalId)}`,
            id: `goal-question-${attention.goalId}-${attention.askedAt}`,
          });
        }
      : undefined,
    runtime: options.runtime,
    provider: options.provider,
    auditPath: options.auditPath,
    agentStoreDir: options.agentStoreDir,
    now: options.now,
    sources: options.sources,
    schedules: options.schedules,
    callerId: options.callerId,
    model: options.model,
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    modelResultLimit: options.modelResultLimit,
    autoCompact: options.autoCompact,
    autoSummary: options.autoSummary,
    autoSummaryDelayMs: options.autoSummaryDelayMs,
    permissionMode: options.permissionMode,
    fullAccessAllowed: options.fullAccessAllowed,
    remoteBashAllowed: options.remoteBashAllowed,
    mcpWritesAllowed: options.mcpWritesAllowed,
    mcpIrreversibleAllowed: options.mcpIrreversibleAllowed,
    maxSubagentConcurrency: options.maxSubagentConcurrency,
    maxSubagentsPerParent: options.maxSubagentsPerParent,
    workspacePath: options.workspacePath,
    outputDirectory: options.outputDirectory,
    mcp:
      options.mcp ??
      createMcpClientRegistry({
        cwd: options.workspacePath,
        serverStates: storedSettings?.mcpServerStates,
      }),
    settingsStore: options.settingsStore,
    memoryStore: options.memoryStore,
    artifactStore: options.artifactStore,
    strmRepairProvider: options.strmRepairProvider,
    navidrome: options.navidrome,
    pipeline: options.pipeline,
    musicResearch: options.musicResearch,
    musicSources: options.musicSources,
    webSearch: options.webSearch,
    emby: options.emby,
    jellyfin: options.jellyfin,
    immich: options.immich,
    backgroundTaskProviders: options.backgroundTaskProviders,
    serviceAPIProviders: options.serviceAPIProviders,
  });
  const prompt: ThebeAppPrompt = async (text) => {
    const result = await agent.prompt(text);
    return { text: result.text, tools: result.tools };
  };
  const handlerOptions: ThebeHttpHandlerOptions = {
    version: options.version ?? "0.1.0",
    token: options.token,
    agent,
    allowedHosts: options.allowedHosts ?? resolveAllowedHosts("127.0.0.1"),
    deviceRegistry,
    pushIdentity:
      pushIdentity && relayUrl
        ? { publicKey: pushIdentity.publicKey, relayUrl }
        : undefined,
    workspacePath: options.workspacePath,
    pushOutbox: pushNotifier,
  };
  const handler = createThebeHttpHandler(handlerOptions);
  const createMcpHandler = (mcp: McpListenerHandlerOptions | undefined) =>
    createThebeHttpHandler({
      ...handlerOptions,
      allowedHosts: mcp?.allowedHosts ?? handlerOptions.allowedHosts,
      mcpOnly: true,
      rateLimiter: mcp?.rateLimit
        ? createRateLimiter(mcp.rateLimit, () =>
            (options.now ?? (() => new Date()))().getTime()
          )
        : undefined,
    });
  return { agent, prompt, send: prompt, handler, createMcpHandler };
}
