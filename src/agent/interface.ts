import type {
  AgentRuntime,
  EnabledResource,
  ForkSessionOptions,
  NormalizedEvent,
  PermissionMode,
  PermissionRememberScope,
  PromptInput,
  RuntimeAuth,
  RuntimeExport,
  RuntimeMessage,
  RuntimeModel,
  RuntimeModelRef,
  RuntimeProvider,
  RuntimeProviderConfiguration,
  RuntimeThinkingInfo,
  ThebeSessionContext,
} from "./runtime/index.ts";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import type { ServiceAPIProvider } from "./capabilities/service-api.ts";
import type { GoalSchedule, GoalScheduleInput } from "./schedules/types.ts";
import type { PolicyApi } from "./policy/service.ts";
import type { TicketApi } from "./tickets/service.ts";
import type { NavidromeProvider } from "./capabilities/navidrome.ts";
import type { PipelineProviders } from "./tools/pipeline-tools.ts";
import type { MusicResearchProvider } from "./capabilities/music-research.ts";
import type { MusicSourcesProvider } from "./capabilities/music-sources.ts";
import type { WebSearchProvider } from "./capabilities/web-search.ts";
import type {
  MediaLibraryProvider,
  PhotoLibraryProvider,
} from "./capabilities/media.ts";
import type { StrmRepairProvider } from "./capabilities/strm.ts";
import type { AgentSessionMeta } from "./store.ts";
import type { GoalEvent } from "./goals/runner.ts";
import type { UsageQuery, UsageSummary } from "./usage/summary.ts";
import type { SkillInfo } from "./extensions/skills.ts";
import type {
  HomelabCapability,
  McpRegistry,
  McpServerInfo,
  McpToolInfo,
} from "./extensions/mcp.ts";
import type {
  CapabilityInvokeInput,
  CapabilityInvokeResult,
  CapabilityRun,
} from "./capabilities/invoke.ts";
import type { ProductPendingPermission } from "./security/pending-permission.ts";
import type {
  AuditPage,
  AuditRecord,
  AuditQuery,
} from "./security/audit/audit-log.ts";
import type { SubagentProfile } from "./subagents/catalog.ts";
import type {
  GoalRun,
  SessionRunStatus,
  SubagentRun,
  SubagentUpdate,
  ThebePromptOptions,
  ThebePromptResult,
} from "./types.ts";
import type { DiagnosisRequest, DiagnosisResult } from "./diagnosis/types.ts";
import type { ActionReceipt, ActionRequest } from "./action/types.ts";
import type { ActivityGroup, ActivityRecord } from "./activity/types.ts";
import type {
  AgentArtifact,
  ArtifactContent,
  ArtifactQuery,
} from "./artifacts/types.ts";
import type { ArtifactStore } from "./artifacts/store.ts";
import type {
  ProductBackgroundTask,
  ProductBackgroundTaskProvider,
} from "./background-tasks/product.ts";
import type {
  AgentSettings,
  AgentSettingsPatch,
  AgentSettingsStore,
} from "./settings/product.ts";
import type { AgentMemoryStore } from "./memory/store.ts";
import type { MemoryOperation, MemoryTarget } from "./memory/memory.ts";
import type { MemoryView } from "./tools/memory-tool.ts";

export type ThebeSession = AgentSessionMeta & {
  status: SessionRunStatus;
  streaming: boolean;
};

export type CreateSessionInput = {
  title?: string;
  labels?: Record<string, string>;
  selectedContext?: AgentSessionMeta["selectedContext"];
  model?: RuntimeModelRef;
  builtinTools?: readonly string[];
};

export type PermissionResolution = {
  response: "allow" | "deny";
  remember?: boolean;
  rememberScope?: PermissionRememberScope;
};

/** Configuration accepted by the agent composition root. */
export type CreateThebeAgentOptions = {
  runtime: AgentRuntime;
  provider: ContainerInfoProvider;
  auditPath?: string;
  agentStoreDir?: string;
  /** Called when an approval starts waiting for a person, for example to send a push notice. */
  onPendingApproval?: (
    record: import("./activity/types.ts").ActivityRecord
  ) => void;
  /** Called once when a goal starts waiting for the owner's answer, for example to send a push notice. */
  onGoalAttention?: (attention: {
    goalId: string;
    question: string;
    askedAt: string;
  }) => void;
  now?: () => Date;
  /**
   * Event sources. `evaluate` runs for each Trigger that passed the Gate, one at a time per Thread;
   * `timer` and `pollIntervalMs` replace the poll loop, which tests drive by hand.
   */
  sources?: {
    evaluate?: import("./sources/runtime.ts").SourceEvaluator;
    timer?: import("./sources/runtime.ts").SourceTimer;
    pollIntervalMs?: number;
  };
  callerId?: string;
  maxToolCalls?: number;
  maxBlocks?: number;
  ttfbMs?: number;
  idleMs?: number;
  watchdogMs?: number;
  toolWatchdogMs?: number;
  /** Opt-in cap on characters one custom tool result may add to the model context. Unset or 0: no cap. */
  modelResultLimit?: number;
  sessionIdleTimeoutMs?: number;
  systemPrompt?: string;
  /** The owner's standing instructions, added after the built-in system prompt. */
  instructions?: string;
  builtinTools?: readonly string[];
  enabledResources?: EnabledResource[];
  model?: RuntimeModelRef;
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  permissionMode?: PermissionMode;
  /**
   * Ignored. `bypassPermissions` is always selectable. The TUI and graphical clients
   * confirm before turning it on. `THEBE_FULL_ACCESS` does not start bypass.
   */
  fullAccessAllowed?: boolean;
  /**
   * Host gate for running a client-supplied command in a session. Defaults to
   * `THEBE_REMOTE_BASH`; off unless the host turns it on.
   */
  remoteBashAllowed?: boolean;
  /**
   * Host gate for write tools over `/mcp`. Defaults to `THEBE_MCP_WRITES`; on unless the host
   * sets it to `off`.
   */
  mcpWritesAllowed?: boolean;
  /**
   * Host gate for irreversible deletes over `/mcp`. Defaults to `THEBE_MCP_IRREVERSIBLE`; on unless the
   * host sets it to `off`, in which case no token may run one.
   */
  mcpIrreversibleAllowed?: boolean;
  maxSubagentConcurrency?: number;
  maxSubagentsPerParent?: number;
  workspacePath?: string;
  outputDirectory?: string;
  /** External MCP capability supplied by the composition root. */
  mcp?: McpRegistry;
  /** Optional provider-owned STRM repair write boundary. */
  strmRepairProvider?: StrmRepairProvider;
  /** Optional Navidrome media provider exposed as Core capabilities. */
  navidrome?: NavidromeProvider;
  /** Optional download → files → library providers exposed as pipeline tools. */
  pipeline?: PipelineProviders;
  musicResearch?: MusicResearchProvider;
  /** Optional NetEase Cloud Music / SQMusic read-only sources. */
  musicSources?: MusicSourcesProvider;
  webSearch?: WebSearchProvider;
  /** Optional Emby library. Exposes search and item detail when present. */
  emby?: MediaLibraryProvider;
  /** Optional Jellyfin library. Exposes search and item detail when present. */
  jellyfin?: MediaLibraryProvider;
  /** Optional Immich library. Exposes semantic search when present. */
  immich?: PhotoLibraryProvider;
  /** Optional provider-native background task sources. */
  backgroundTaskProviders?: readonly ProductBackgroundTaskProvider[];
  serviceAPIProviders?: readonly ServiceAPIProvider[];
  /** Optional persistence boundary for product-facing Agent settings. */
  settingsStore?: AgentSettingsStore;
  /** Where Thebe Memory is kept. Without one the agent has no memory tool and no memory section. */
  memoryStore?: AgentMemoryStore;
  /** Optional persistence boundary for product-facing Artifacts. */
  artifactStore?: ArtifactStore;
};

/**
 * Who is calling over `/mcp`, as far as the gate cares: the token's name, what it may do, and its
 * scopes as stored. Later gateway rules (category limits, tickets) read the same shape.
 */
export type McpCaller = {
  /** The token's name, recorded in the audit log. */
  name: string;
  /** Whether the token may run write tools. */
  writes: boolean;
  /** Whether the token may run irreversible deletes (judged per call). */
  irreversible: boolean;
  /** The token's scopes; absent for a token with full access. */
  scopes?: readonly string[];
  /** The service categories a write token is limited to; absent means every category. */
  categories?: readonly string[];
};

/** Stable agent seam consumed by CLI, Serve, TUI, and integrations. */
export interface ThebeAgent {
  readonly runtime: AgentRuntime;
  readonly workspacePath: string | undefined;

  prompt(
    input: string | PromptInput,
    options?: ThebePromptOptions
  ): Promise<ThebePromptResult>;
  send(text: string, thebeSessionId?: string): Promise<ThebePromptResult>;
  toolNames(): string[];
  lastThebeSessionId(): string | undefined;
  lastEvents(): NormalizedEvent[];
  events(thebeSessionId?: string): NormalizedEvent[];
  subscribeLog(
    thebeSessionId: string,
    listener: (event: NormalizedEvent) => void
  ): () => void;
  messages(): RuntimeMessage[];
  loadMessages(thebeSessionId: string): Promise<RuntimeMessage[]>;
  message(
    thebeSessionId: string,
    messageId: string
  ): Promise<RuntimeMessage | undefined>;
  isStreaming(thebeSessionId: string): boolean;
  isBusy(thebeSessionId: string): boolean;
  emitLog(thebeSessionId: string, event: NormalizedEvent): void;
  recentEvents(
    limit?: number
  ): Array<NormalizedEvent & { thebeSessionId: string }>;

  createSession(init?: CreateSessionInput): Promise<AgentSessionMeta>;
  listSessions(query?: {
    status?: string;
    hostId?: string;
    environmentId?: string;
  }): Promise<ThebeSession[]>;
  getSession(thebeSessionId: string): Promise<AgentSessionMeta>;
  patchSession(
    thebeSessionId: string,
    patch: Partial<
      Pick<
        AgentSessionMeta,
        | "title"
        | "labels"
        | "selectedContext"
        | "shareMetadata"
        | "rememberedPermissions"
      >
    >
  ): Promise<AgentSessionMeta>;
  deleteSession(thebeSessionId: string): Promise<void>;
  sessionStatus(): Promise<ThebeSession[]>;
  resume(thebeSessionId: string): Promise<AgentSessionMeta>;
  fork(
    thebeSessionId?: string,
    options?: string | { atEntryId?: string; mode?: ForkSessionOptions["mode"] }
  ): Promise<AgentSessionMeta>;
  children(thebeSessionId: string): Promise<AgentSessionMeta[]>;
  compact(thebeSessionId?: string, customInstructions?: string): Promise<void>;
  setAutoCompactionEnabled(
    thebeSessionId: string | undefined,
    enabled: boolean
  ): Promise<void>;
  setAutoSummaryEnabled(enabled: boolean): Promise<void>;
  autoSummaryEnabled(): boolean;
  setAutoSummaryDelayMs(delayMs: number): Promise<void>;
  autoSummaryDelayMs(): number;
  interrupt(thebeSessionId?: string): Promise<void>;
  revert(thebeSessionId?: string): Promise<void>;
  unrevert(thebeSessionId?: string): Promise<void>;
  resolvePermission(
    thebeSessionId: string,
    permissionId: string,
    decision: PermissionResolution
  ): Promise<void>;
  pendingPermissionIds(): string[];
  listPendingPermissions(): ProductPendingPermission[];
  getPendingPermission(id: string): ProductPendingPermission | undefined;
  resolvePendingPermission(
    id: string,
    decision: PermissionResolution
  ): Promise<void>;
  setModel(thebeSessionId: string, model: RuntimeModelRef): Promise<void>;
  setThinkingLevel(
    thebeSessionId: string,
    level: import("./runtime/interface.ts").ThinkingLevel
  ): Promise<RuntimeThinkingInfo>;
  getThinkingInfo(thebeSessionId: string): Promise<RuntimeThinkingInfo>;

  listSkills(): Promise<SkillInfo[]>;
  importSkill(content: string): Promise<SkillInfo>;
  addMcpServer(
    input: import("./extensions/mcp.ts").McpServerRegistration
  ): Promise<McpServerInfo>;
  getSkill(name: string): Promise<SkillInfo | undefined>;
  enableSkill(name: string): Promise<void>;
  disableSkill(name: string): Promise<void>;
  listCapabilities(): Promise<HomelabCapability[]>;
  listMcpTools(): Promise<McpToolInfo[]>;
  listMcpServers(): Promise<McpServerInfo[]>;
  setMcpServerEnabled(
    name: string,
    enabled: boolean
  ): Promise<McpServerInfo | undefined>;
  /** Deletes a server registered through Thebe; false when it does not exist. */
  removeMcpServer(name: string): Promise<boolean>;
  closeMcp(): void;
  listSubagentProfiles(): Promise<SubagentProfile[]>;
  spawnSubagent(input: {
    profileName: string;
    taskPrompt: string;
    parentSessionId: string;
  }): Promise<SubagentRun>;
  listSubagents(parentSessionId?: string): Promise<SubagentRun[]>;
  restoreSubagents(parentSessionId: string, restoredRuns: SubagentRun[]): void;
  getSubagent(runId: string): SubagentRun | undefined;
  subscribeSubagent(
    runId: string,
    listener: (update: SubagentUpdate) => void
  ): () => void;
  subscribeSubagents(
    parentSessionId: string | undefined,
    listener: (update: SubagentUpdate) => void
  ): () => void;
  waitSubagent(runId: string): Promise<SubagentRun>;
  cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun>;
  getForkMessages(
    thebeSessionId?: string
  ): Promise<Array<{ entryId: string; text: string }>>;
  enableResource(resource: EnabledResource): Promise<void>;
  putEnabledResource(resource: EnabledResource): Promise<EnabledResource>;
  removeEnabledResource(identity: string): Promise<boolean>;
  enabledResources(): EnabledResource[];
  createEnabledResourceArtifact(): Promise<AgentArtifact>;

  /**
   * Starts a goal the owner asked for and records the ticket that wraps it. `triggerId` names the
   * request (a chat message, a client request id): starting again with the same one returns the goal it
   * already started and produces no second ticket.
   */
  startGoal(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    maxIterations?: number;
    triggerId?: string;
  }): Promise<GoalRun>;
  /** The goal an earlier request with this trigger id started, if any. */
  goalForTrigger: TicketApi["goalForTrigger"];
  /** Runs the task after earlier tasks for the same trigger id, so concurrent retries start one goal. */
  exclusiveForTrigger: TicketApi["exclusiveForTrigger"];
  /** Tickets with their derived stage, newest first. Read-only. */
  listTickets: TicketApi["listTickets"];
  getTicket: TicketApi["getTicket"];
  /** Goal endpoints take a session id or a ticket id; this gives the session id for either. */
  resolveGoalId: TicketApi["resolveGoalId"];
  /** Which ticket wraps which object, for putting `ticketId` on responses. */
  ticketIndex: TicketApi["ticketIndex"];
  listSchedules(): Promise<GoalSchedule[]>;
  getSchedule(id: string): Promise<GoalSchedule>;
  createSchedule(input: GoalScheduleInput): Promise<GoalSchedule>;
  updateSchedule(id: string, input: GoalScheduleInput): Promise<GoalSchedule>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<GoalSchedule>;
  deleteSchedule(id: string): Promise<void>;
  runSchedule(id: string): Promise<GoalSchedule>;
  /**
   * The versioned policy (rules, accept mode, per-source settings). The owner's HTTP requests are the
   * only way to change it; no tool exposes it.
   */
  getPolicy: PolicyApi["getPolicy"];
  getPolicyVersion: PolicyApi["getPolicyVersion"];
  listPolicyVersions: PolicyApi["listPolicyVersions"];
  updatePolicy: PolicyApi["updatePolicy"];
  getGoal(thebeSessionId: string): GoalRun | undefined;
  listGoals(): Promise<GoalRun[]>;
  goalEvents(thebeSessionId: string): Array<{ event: GoalEvent; at: string }>;
  restoreGoal(run: GoalRun | undefined): void;
  subscribeGoal(
    thebeSessionId: string,
    listener: (event: GoalEvent) => void
  ): () => void;
  waitGoal(thebeSessionId: string): Promise<GoalRun>;
  pauseGoal(thebeSessionId: string): Promise<GoalRun>;
  resumeGoal(thebeSessionId: string): Promise<GoalRun>;
  /** Answers the goal's one open question and resumes the same session. Rejects when none is open. */
  answerGoal(thebeSessionId: string, answer: string): Promise<GoalRun>;
  stopGoal(thebeSessionId: string): Promise<GoalRun>;
  clearGoal(thebeSessionId: string): void;

  permissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  updatePermissionMode(mode: PermissionMode): Promise<PermissionMode>;
  /** Whether this host permits the session-scoped full-access preset. */
  getFullAccessSupport(): { allowed: boolean };
  /**
   * Set one session's permission mode. Session-scoped and never inherited by
   * subagents, schedules, background goals, or `/mcp`.
   */
  setSessionPermissionMode(
    thebeSessionId: string,
    mode: PermissionMode | undefined
  ): Promise<{ thebeSessionId: string; mode: PermissionMode }>;
  sessionPermissionMode(thebeSessionId: string): Promise<{
    thebeSessionId: string;
    mode: PermissionMode;
    inherited: boolean;
  }>;
  setSessionFullAccess(
    thebeSessionId: string,
    enabled: boolean
  ): Promise<{ thebeSessionId: string; fullAccess: boolean }>;
  getAgentSettings(): AgentSettings;
  updateAgentSettings(patch: AgentSettingsPatch): Promise<AgentSettings>;
  /** Thebe Memory as saved now; empty when no memory store is configured. */
  getMemory(): { enabled: boolean; memory: MemoryView };
  /** The owner's edit of Thebe Memory (no approval: the owner is the one asking). */
  editMemory(
    target: MemoryTarget,
    operations: MemoryOperation[]
  ): Promise<{ ok: boolean; error?: string; memory: MemoryView }>;
  listModels(query?: {
    all?: boolean;
    providerId?: string;
    refresh?: boolean;
  }): Promise<RuntimeModel[]>;
  testModel(
    model: RuntimeModelRef,
    query?: { timeoutMs?: number }
  ): Promise<{
    providerId: string;
    modelId: string;
    text: string;
    latencyMs: number;
  }>;
  listAvailableModels(query?: { providerId?: string }): Promise<RuntimeModel[]>;
  listProviders(query?: { all?: boolean }): Promise<RuntimeProvider[]>;
  providerConfiguration(
    providerId: string
  ): Promise<RuntimeProviderConfiguration | undefined>;
  saveProviderConfiguration(
    configuration: RuntimeProviderConfiguration,
    apiKey?: string
  ): Promise<void>;
  deleteProviderConfiguration(providerId: string): Promise<void>;
  exportSession(thebeSessionId?: string): Promise<RuntimeExport>;
  invokeTool(name: string, args: unknown): Promise<string>;
  /** `invokeTool` plus the tool's own failure flag, for the MCP `isError` result. */
  invokeToolDetailed(
    name: string,
    args: unknown
  ): Promise<{ text: string; isError: boolean }>;
  /**
   * `invokeToolDetailed` for a caller on `/mcp`: read tools run as before, and a write tool runs
   * only when the host has enabled writes over `/mcp` and the caller may write. An irreversible
   * delete (judged per call) also needs the host to allow it and the caller to hold that scope; a
   * refusal is an immediate error, never a wait. The caller is required, so a route that forgets it does not compile instead of quietly allowing writes.
   * The call is audited.
   */
  invokeMcpTool(
    name: string,
    args: unknown,
    caller: McpCaller
  ): Promise<{ text: string; isError: boolean }>;
  invokeCapability(
    id: string,
    input?: CapabilityInvokeInput
  ): Promise<CapabilityInvokeResult>;
  getCapabilityRun(runId: string): Promise<CapabilityRun | undefined>;
  listCapabilityRuns(): Promise<CapabilityRun[]>;
  subscribeCapabilityRun(
    runId: string,
    listener: (run: CapabilityRun) => void
  ): () => void;
  diagnose(request: DiagnosisRequest): Promise<DiagnosisResult>;
  getDiagnosis(runId: string): Promise<DiagnosisResult | undefined>;
  explainDiagnosis(runId: string, question?: string): Promise<DiagnosisResult>;
  executeApprovedAction(request: ActionRequest): Promise<ActionReceipt>;
  getReceipt(receiptId: string): Promise<ActionReceipt | undefined>;
  listArtifacts(query?: ArtifactQuery): Promise<AgentArtifact[]>;
  getArtifact(artifactId: string): Promise<AgentArtifact | undefined>;
  getArtifactContent(artifactId: string): Promise<ArtifactContent | undefined>;
  listActivity(group?: ActivityGroup): Promise<ActivityRecord[]>;
  /** What projecting items needs besides each item: the agent clock, which goals wait on a confirmation and which tickets wrap what. */
  activityStageContext(): Promise<import("./activity/stage.ts").StageContext>;
  /** Every Trigger the sources produced, with the Gate outcome recorded for it. */
  listTriggers(): Promise<import("./sources/types.ts").TriggerRecord[]>;
  /** How each source is reading; shown in the health response. */
  sourceHealth(): Record<string, import("./sources/types.ts").SourceHealth>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  denyActivity(id: string): Promise<boolean>;
  listAudit(query?: AuditQuery): Promise<AuditPage>;
  getAudit(id: string): Promise<AuditRecord | undefined>;
  /**
   * Read-only usage and effect numbers for a day range, computed on demand from the stores Core
   * already keeps. Stores nothing and reports nothing out.
   */
  getUsageSummary(query: UsageQuery): Promise<UsageSummary>;
  getContext(thebeSessionId: string): Promise<ThebeSessionContext>;
  getContextUsage(thebeSessionId: string): Promise<ThebeSessionContext>;
  stopToolCall(thebeSessionId: string, toolCallId: string): Promise<void>;
  listBackgroundTasks(thebeSessionId: string): Promise<ProductBackgroundTask[]>;
  listAllBackgroundTasks(): Promise<ProductBackgroundTask[]>;
  stopBackgroundTask(thebeSessionId: string, taskId: string): Promise<void>;
  stopAllBackgroundTasks(thebeSessionId: string): Promise<void>;
  executeBash(
    thebeSessionId: string,
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean }
  ): Promise<{ exitCode?: number; cancelled: boolean; output: string }>;
  /**
   * Run one command the client has already had approved. Host-gated; refused when the command
   * guard rates it dangerous or critical; the output is redacted and bounded; every run is audited.
   */
  runRemoteCommand(
    thebeSessionId: string,
    command: string
  ): Promise<{
    exitCode?: number;
    cancelled: boolean;
    output: string;
    truncated: boolean;
  }>;
  quiesce(): Promise<void>;
  unquiesce(): Promise<void>;
  reapIdleSessions(idleMs?: number): Promise<{ reaped: number }>;
  isQuiesced(): boolean;
  auth(): RuntimeAuth;
}

export type { ContainerInfoProvider };
