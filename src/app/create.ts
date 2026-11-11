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
import { createThebeHttpHandler } from "../delivery/http/handler.ts";
import { createDeviceRegistry } from "../delivery/http/devices.ts";
import { createPushIdentity } from "./push/identity.ts";
import { createQuietHoursStore } from "../delivery/http/quiet-hours.ts";
import { createQuietHoursNotifier } from "./push/quiet-notifier.ts";
import { createPushNotifier } from "./push/notifier.ts";
import { createThebeAgent, type ThebeAgent } from "../agent/index.ts";
import { createMcpClientRegistry } from "../adapters/mcp/index.ts";
import type { McpRegistry } from "../agent/extensions/mcp.ts";
import type { AgentSettingsStore } from "../agent/settings/product.ts";
import type { AgentMemoryStore } from "../agent/memory/store.ts";
import type { ArtifactStore } from "../agent/artifacts/store.ts";
import type { StrmRepairProvider } from "../agent/capabilities/strm.ts";
import type { ProductBackgroundTaskProvider } from "../agent/background-tasks/product.ts";
import type { OAuthHttpIntegration } from "../delivery/http/oauth/service.ts";

export type ThebeAppPrompt = (
  text: string
) => Promise<{ text: string; tools: string[] }>;

/** @deprecated Use ThebeAppPrompt */
export type ThebeAppSend = ThebeAppPrompt;

export function createThebeApp(options: {
  runtime: AgentRuntime;
  provider: ContainerInfoProvider;
  version?: string;
  token?:
    | string
    | import("../delivery/http/token-store.ts").TokenSource
    | import("../delivery/http/token-store.ts").TokenVerifier
    | import("../delivery/http/token-store.ts").AsyncTokenVerifier;
  auditPath?: string;
  agentStoreDir?: string;
  /** Sources Core watches for events; see `CreateThebeAgentOptions.sources`. Off unless given. */
  sources?: {
    containerHealth?: boolean;
    downloadCompleted?: boolean;
    intervalMs?: number;
  };
  /** Eval's hourly limit on questions to the model; see `CreateThebeAgentOptions.evalMaxPerHour`. */
  evalMaxPerHour?: number;
  /** Autonomous model tokens per UTC day; see `CreateThebeAgentOptions.dailyBackgroundTokenBudget`. */
  dailyBackgroundTokenBudget?: number;
  /** Maximum word/token limit for proactive messages (default: 100). */
  maxProactiveWords?: number;
  /** Autonomous budget warning thresholds (e.g. [0.5, 0.8, 0.9, 1.0]); see `CreateThebeAgentOptions.dailyBackgroundTokenBudgetThresholds`. */
  dailyBackgroundTokenBudgetThresholds?: number[];
  /** Deterministic stuck-task thresholds; see `CreateThebeAgentOptions.watchdog`. */
  watchdog?: {
    intervalMs?: number;
    goalFirstMs?: number;
    goalSecondMs?: number;
    workerFirstMs?: number;
    workerSecondMs?: number;
  };
  /** The Push Relay events are sent to. Unset: Core registers devices but sends no push. */
  pushRelayUrl?: string;
  /** Replaces `fetch` for calls to the Push Relay; tests use it to stand in for the relay. */
  pushFetch?: typeof fetch;
  now?: () => Date;
  callerId?: string;
  model?: import("../agent/runtime/interface.ts").RuntimeModelRef;
  mainSessionModel?: import("../agent/runtime/interface.ts").RuntimeModelRef;
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
  oauth?: OAuthHttpIntegration;
}): {
  agent: ThebeAgent;
  prompt: ThebeAppPrompt;
  send: ThebeAppSend;
  handler: ReturnType<typeof createThebeHttpHandler>;
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
  // Quiet hours only delay the push; the approval itself is already waiting.
  const quietHours = createQuietHoursStore({ dir: deviceDir });
  const notifier = pushNotifier
    ? createQuietHoursNotifier({
        inner: pushNotifier,
        quiet: quietHours,
        dir: deviceDir,
      })
    : undefined;
  void notifier?.resume();
  const agent = createThebeAgent({
    onPendingApproval: notifier
      ? (record) => {
          void notifier.notify({
            category: "thebe.permission",
            title: "Thebe",
            body: "An action is waiting for your approval.",
            deepLink: `thebe://approval/${encodeURIComponent(record.id)}`,
            id: `approval-${record.id}`,
          });
        }
      : undefined,
    onGoalNeedsPerson: notifier
      ? (notice) =>
          notifier.notify({
            category: "thebe.activity",
            title: "Thebe",
            body: notice.message,
            deepLink: `thebe://goal/${encodeURIComponent(notice.goalId)}`,
            id: notice.id,
            ticket: notice.ticketId ?? notice.goalId,
          })
      : undefined,
    onEvalUnavailable: notifier
      ? (notice) =>
          notifier.notify({
            category: "thebe.activity",
            title: "Thebe",
            body: notice.message,
            deepLink: "thebe://core",
            id: notice.id,
          })
      : undefined,
    onBackgroundBudgetPaused: notifier
      ? (notice) =>
          notifier.notify({
            category: "thebe.activity",
            title: "Background work paused",
            body: notice.message,
            deepLink: "thebe://usage",
            id: notice.id,
          })
      : undefined,
    onBackgroundBudgetThreshold: notifier
      ? (notice) =>
          notifier.notify({
            category: "thebe.activity",
            title:
              notice.title ??
              `Background budget at ${Math.round((notice.threshold ?? 1) * 100)}%`,
            body: notice.message,
            deepLink: "thebe://usage",
            id: notice.id,
          })
      : undefined,
    onProactiveMessage: notifier
      ? (notice) =>
          notifier.notify({
            category: "thebe.activity",
            title: "Thebe",
            body: notice.summary ?? notice.body,
            deepLink: notice.deepLink ?? "thebe://main-session",
            id: notice.id,
            ticket: notice.ticketId,
          })
      : undefined,
    runtime: options.runtime,
    provider: options.provider,
    auditPath: options.auditPath,
    agentStoreDir: options.agentStoreDir,
    sources: options.sources,
    evalMaxPerHour: options.evalMaxPerHour,
    dailyBackgroundTokenBudget: options.dailyBackgroundTokenBudget,
    maxProactiveWords: options.maxProactiveWords,
    dailyBackgroundTokenBudgetThresholds:
      options.dailyBackgroundTokenBudgetThresholds,
    watchdog: options.watchdog,
    now: options.now,
    callerId: options.callerId,
    model: options.model,
    mainSessionModel: options.mainSessionModel,
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    modelResultLimit: options.modelResultLimit,
    autoCompact: options.autoCompact,
    autoSummary: options.autoSummary,
    autoSummaryDelayMs: options.autoSummaryDelayMs,
    permissionMode: options.permissionMode,
    fullAccessAllowed: options.fullAccessAllowed,
    remoteBashAllowed: options.remoteBashAllowed,
    mcpWritesAllowed: options.mcpWritesAllowed,
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
  const handler = createThebeHttpHandler({
    version: options.version ?? "0.1.0",
    token: options.token,
    agent,
    allowedHosts: options.allowedHosts ?? resolveAllowedHosts("127.0.0.1"),
    deviceRegistry,
    pushIdentity:
      pushIdentity && relayUrl
        ? { publicKey: pushIdentity.publicKey, relayUrl }
        : undefined,
    quietHours,
    pushOutbox: pushNotifier,
    workspacePath: options.workspacePath,
    oauth: options.oauth,
  });
  return { agent, prompt, send: prompt, handler };
}
