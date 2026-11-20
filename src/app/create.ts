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
import { createQuietHoursStore } from "../agent/notifications/quiet-hours.ts";
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
import type { Source } from "../agent/sources/types.ts";
import type { ChannelAdapter } from "../agent/channels/types.ts";
import { key } from "../agent/tickets/ids.ts";
import {
  createNotificationService,
  type NotificationService,
} from "../agent/notifications/service.ts";
import { createNotificationChannelConfigService } from "../agent/notifications/channel-config-service.ts";
import type { NotificationChannelConfig } from "../agent/notifications/channel-config.ts";
import type {
  NotificationAdapter,
  NotificationTarget,
} from "../agent/notifications/types.ts";
import { priorityForGoalNotice } from "../agent/notifications/types.ts";
import type { ChannelRef } from "../agent/sources/types.ts";
import { createChannelNotificationAdapter } from "../adapters/notifications/channel.ts";
import { createImNotificationAdapter } from "../adapters/notifications/im.ts";
import { createImIntegration } from "./im.ts";
import type { ImGateway } from "../agent/im/gateway.ts";
import type { ImAdapterFactory } from "../agent/im/types.ts";

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
  /** Host supplied Sources polled alongside the built-in ones (GitHub, Feishu, …). */
  sourceAdapters?: readonly Source[];
  /** Host supplied reply channels for Ticket notices, matching `ChannelRef.source`. */
  channelAdapters?: readonly ChannelAdapter[];
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
  /** Multi-channel notification transports (webhook, Telegram, WeCom, DingTalk, email). */
  notificationAdapters?: readonly NotificationAdapter[];
  /** Inject a composed notification service; tests use it to observe or replace delivery. */
  notifications?: NotificationService;
  /** Rebuild notification adapters when the owner-only channel config changes. */
  notificationConfig?: {
    dir: string;
    build: (
      config: NotificationChannelConfig
    ) => readonly NotificationAdapter[];
    watch?: boolean;
  };
  /**
   * Two-way IM channels. Omit and the feature is absent; the server passes the host environment,
   * which seeds an environment-owned Telegram account when `THEBE_TELEGRAM_BOT_TOKEN` is set.
   */
  im?: {
    dir?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    factories?: readonly ImAdapterFactory[];
  };
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
  im?: ImGateway;
} {
  const storedSettings = options.settingsStore?.load();
  const clock = options.now ?? (() => new Date());
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
  // A Ticket's recorded channel is a default notification target; wrapping the same ChannelAdapter
  // keeps its write-back and idempotency behaviour instead of adding a second delivery stack.
  const ticketNotificationAdapters = (options.channelAdapters ?? []).map(
    createChannelNotificationAdapter
  );
  let imNotificationAdapters: NotificationAdapter[] = [];
  const combineAdapters = (
    built: readonly NotificationAdapter[]
  ): NotificationAdapter[] => {
    const seen = new Set<string>();
    const combined = [
      ...built,
      ...imNotificationAdapters,
      ...ticketNotificationAdapters,
    ];
    return combined.filter((adapter) => {
      if (seen.has(adapter.id)) return false;
      seen.add(adapter.id);
      return true;
    });
  };
  const notificationAdapters = combineAdapters(
    options.notificationAdapters ?? []
  );
  const notifications =
    options.notifications ??
    createNotificationService({
      adapters: notificationAdapters,
      dir: options.agentStoreDir
        ? join(options.agentStoreDir, "notifications")
        : undefined,
      now: clock,
    });
  const notificationConfig = options.notificationConfig
    ? createNotificationChannelConfigService({
        dir: options.notificationConfig.dir,
        buildAdapters: (config) =>
          combineAdapters(options.notificationConfig!.build(config)),
        onChange: (adapters) => notifications.setAdapters(adapters),
        watch: options.notificationConfig.watch,
      })
    : undefined;
  void notificationConfig?.start();
  const notifier = pushNotifier
    ? createQuietHoursNotifier({
        inner: pushNotifier,
        quiet: quietHours,
        dir: deviceDir,
      })
    : undefined;
  void notifier?.resume();
  const ticketTargets = (
    channels: readonly ChannelRef[] | undefined
  ): NotificationTarget[] =>
    (channels ?? []).map((channel) => ({
      id: `ticket:${key(
        "notification-target",
        channel.source,
        channel.thread,
        ...Object.entries(channel.address ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([name, value]) => [name, value])
      )}`,
      channel,
      categories: "all",
      enabled: true,
    }));
  const agent = createThebeAgent({
    onSourceFollowUpNotice: async (notice, channel) => {
      await notifications.notify(
        {
          id: notice.id,
          category: "attention",
          priority: "normal",
          title: "Thebe",
          body: notice.message,
          ticketId: notice.ticketId,
          goalId: notice.goalId,
          sourceFollowUp: notice.type,
          createdAt: clock().toISOString(),
        },
        { onlyTargets: ticketTargets([channel]) }
      );
    },
    onPendingApproval: (record) => {
      void notifier?.notify({
        category: "thebe.permission",
        title: "Thebe",
        body: "An action is waiting for your approval.",
        deepLink: `thebe://approval/${encodeURIComponent(record.id)}`,
        id: `approval-${record.id}`,
      });
      void notifications.notify({
        id: `approval-${record.id}`,
        category: "attention",
        priority: "critical",
        title: "Thebe",
        body: "An action is waiting for your approval.",
        deepLink: `thebe://approval/${encodeURIComponent(record.id)}`,
        createdAt: clock().toISOString(),
      });
    },
    onGoalNeedsPerson: async (notice) => {
      await notifier?.notify({
        category: "thebe.activity",
        title: "Thebe",
        body: notice.message,
        deepLink: `thebe://goal/${encodeURIComponent(notice.goalId)}`,
        id: notice.id,
        ticket: notice.ticketId ?? notice.goalId,
      });
      await notifications.notify(
        {
          id: notice.id,
          category: "attention",
          priority: priorityForGoalNotice("goal_needs_person", notice.reason),
          title: "Thebe",
          body: notice.message,
          deepLink: `thebe://goal/${encodeURIComponent(notice.goalId)}`,
          ...(notice.ticketId ? { ticketId: notice.ticketId } : {}),
          goalId: notice.goalId,
          ticketReason: notice.reason,
          createdAt: clock().toISOString(),
        },
        { extraTargets: ticketTargets(notice.channels) }
      );
    },
    onGoalCompleted: async (notice) => {
      await notifier?.notify({
        category: "thebe.activity",
        title: "Thebe",
        body: notice.message,
        deepLink: `thebe://goal/${encodeURIComponent(notice.goalId)}`,
        id: notice.id,
        ticket: notice.ticketId ?? notice.goalId,
      });
      await notifications.notify(
        {
          id: notice.id,
          category: "completed",
          priority: "normal",
          title: "Thebe",
          body: notice.message,
          deepLink: `thebe://goal/${encodeURIComponent(notice.goalId)}`,
          ...(notice.ticketId ? { ticketId: notice.ticketId } : {}),
          goalId: notice.goalId,
          createdAt: clock().toISOString(),
        },
        { extraTargets: ticketTargets(notice.channels) }
      );
    },
    onEvalUnavailable: async (notice) => {
      await notifier?.notify({
        category: "thebe.activity",
        title: "Thebe",
        body: notice.message,
        deepLink: "thebe://core",
        id: notice.id,
      });
      await notifications.notify({
        id: notice.id,
        category: "source_health",
        priority: "normal",
        title: "Thebe",
        body: notice.message,
        deepLink: "thebe://core",
        createdAt: clock().toISOString(),
      });
    },
    onBackgroundBudgetPaused: async (notice) => {
      await notifier?.notify({
        category: "thebe.activity",
        title: "Background work paused",
        body: notice.message,
        deepLink: "thebe://usage",
        id: notice.id,
      });
      await notifications.notify({
        id: notice.id,
        category: "budget",
        priority: "critical",
        title: "Background work paused",
        body: notice.message,
        deepLink: "thebe://usage",
        createdAt: clock().toISOString(),
      });
    },
    onBackgroundBudgetThreshold: async (notice) => {
      await notifier?.notify({
        category: "thebe.activity",
        title:
          notice.title ??
          `Background budget at ${Math.round((notice.threshold ?? 1) * 100)}%`,
        body: notice.message,
        deepLink: "thebe://usage",
        id: notice.id,
      });
      await notifications.notify({
        id: notice.id,
        category: "budget",
        priority: "normal",
        title:
          notice.title ??
          `Background budget at ${Math.round((notice.threshold ?? 1) * 100)}%`,
        body: notice.message,
        deepLink: "thebe://usage",
        createdAt: clock().toISOString(),
      });
    },
    onProactiveMessage: async (notice) => {
      await notifier?.notify({
        category: "thebe.activity",
        title: "Thebe",
        body: notice.summary ?? notice.body,
        deepLink: notice.deepLink ?? "thebe://main-session",
        id: notice.id,
        ticket: notice.ticketId,
      });
      await notifications.notify({
        id: notice.id,
        category: "attention",
        priority: "normal",
        title: "Thebe",
        body: notice.summary ?? notice.body,
        deepLink: notice.deepLink ?? "thebe://main-session",
        ...(notice.ticketId ? { ticketId: notice.ticketId } : {}),
        createdAt: clock().toISOString(),
      });
    },
    runtime: options.runtime,
    provider: options.provider,
    auditPath: options.auditPath,
    agentStoreDir: options.agentStoreDir,
    sources: options.sources,
    sourceAdapters: options.sourceAdapters,
    channelAdapters: options.channelAdapters,
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
  const imAgent = {
    askMainSession: (
      input: string,
      promptOptions?: { mode?: "prompt" | "followUp" }
    ) => agent.askMainSession(input, promptOptions),
    isMainSessionBusy: () => agent.isBusy(agent.mainSessionId),
    isMainSessionStreaming: () => agent.isStreaming(agent.mainSessionId),
  };
  const im = options.im
    ? createImIntegration({
        agent: imAgent,
        dir:
          options.im.dir ??
          (options.agentStoreDir
            ? join(options.agentStoreDir, "im")
            : undefined),
        env: options.im.env,
        fetch: options.im.fetch,
        factories: options.im.factories,
        now: clock,
      })
    : undefined;
  // Startup is background: a channel that cannot connect must not delay the HTTP listener.
  void im?.start().catch(() => {});
  if (im) {
    // The IM gateway exists only after the agent, so add its notification transport once both exist.
    imNotificationAdapters = [createImNotificationAdapter({ im })];
    notifications.setAdapters(
      combineAdapters(options.notificationAdapters ?? [])
    );
  }
  // Start delivery only after every adapter, including the IM transport, is registered. A queued
  // notice must not be dropped as adapter_missing during startup.
  notifications.start();
  const prompt: ThebeAppPrompt = async (text) => {
    const result = await agent.prompt(text);
    return { text: result.text, tools: result.tools };
  };
  // Notification delivery is app-level, so quiesce has to stop its timer too; otherwise a maintenance
  // window could still write outbox state while the rest of Core is idle.
  const quiesce = agent.quiesce.bind(agent);
  const unquiesce = agent.unquiesce.bind(agent);
  agent.quiesce = async () => {
    // Let an in-flight notice finish while its IM transport is still running, then stop the channel.
    await notifications.stop();
    await im?.stop();
    await quiesce();
  };
  agent.unquiesce = async () => {
    await unquiesce();
    await im?.start();
    notifications.start();
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
    notifications,
    notificationConfig,
    im,
    workspacePath: options.workspacePath,
    oauth: options.oauth,
  });
  return { agent, prompt, send: prompt, handler, ...(im ? { im } : {}) };
}
