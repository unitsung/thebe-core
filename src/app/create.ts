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
import { createPushNotifier } from "./push/notifier.ts";
import { createThebeAgent, type ThebeAgent } from "../agent/index.ts";
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
  now?: () => Date;
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
    runtime: options.runtime,
    provider: options.provider,
    auditPath: options.auditPath,
    agentStoreDir: options.agentStoreDir,
    now: options.now,
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
    workspacePath: options.workspacePath,
  });
  return { agent, prompt, send: prompt, handler };
}
