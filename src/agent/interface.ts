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
import type { Ticket } from "./tickets/types.ts";
import type { TicketTaskView } from "./tickets/control.ts";
import type {
  MainSessionInfo,
  MainSessionPromptOptions,
} from "./main-session/service.ts";
import type { Trigger } from "./sources/types.ts";
import type { SourceHealth } from "./sources/runner.ts";
import type { Decision, Policy } from "./eval/types.ts";
import type { EvalUnavailableNotice } from "./eval/service.ts";
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
  /**
   * Sources Core watches for events (Triggers). Off unless given: a Core that was not asked to watch
   * anything starts no timers and reads nothing.
   */
  sources?: {
    containerHealth?: boolean;
    downloadCompleted?: boolean;
    intervalMs?: number;
  };
  /**
   * How many times an hour Eval may ask the model before the rest are recorded as `unavailable`
   * (`assessment_limit`). A circuit breaker for a noisy Source, not a budget. Unset: 60; 0: no limit.
   */
  evalMaxPerHour?: number;
  /** Called when an approval starts waiting for a person, for example to send a push notice. */
  onPendingApproval?: (
    record: import("./activity/types.ts").ActivityRecord
  ) => void;
  /** Called once when a Goal enters `person`: a question, review, blocker, or Watchdog escalation. */
  onGoalNeedsPerson?: (
    notice: import("./goals/service.ts").GoalNeedsPersonNotice
  ) => Promise<void> | void;
  /** Called once when assessment fails and again only after a successful assessment. */
  onEvalUnavailable?: (notice: EvalUnavailableNotice) => Promise<void> | void;
  /** Deterministic stuck-task thresholds. Defaults: 60 s scan; Goal 30/60 min; worker/reviewer 10/10 min. */
  watchdog?: {
    intervalMs?: number;
    goalFirstMs?: number;
    goalSecondMs?: number;
    workerFirstMs?: number;
    workerSecondMs?: number;
  };
  now?: () => Date;
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
  /** Optional cheaper model for the one durable main Session; defaults to the host model. */
  mainSessionModel?: RuntimeModelRef;
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
 * Who is calling over `/mcp`, as far as the write gate cares: whether their token may run write tools,
 * and whether it may also run the deletes that cannot be undone.
 */
export type McpCaller = {
  /** The token's name, recorded in the audit log; absent when no token is configured. */
  name?: string;
  writes: boolean;
  irreversible: boolean;
};

/** Stable agent seam consumed by CLI, Serve, TUI, and integrations. */
export interface ThebeAgent {
  readonly runtime: AgentRuntime;
  readonly workspacePath: string | undefined;
  readonly mainSessionId: string;

  prompt(
    input: string | PromptInput,
    options?: ThebePromptOptions
  ): Promise<ThebePromptResult>;
  /** The one durable entry point; undefined until the person first speaks to it. */
  getMainSession(): Promise<MainSessionInfo | undefined>;
  /** Start or resume the main Session and send it one person-facing turn. */
  askMainSession(
    input: string | PromptInput,
    options?: MainSessionPromptOptions
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

  startGoal(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    maxIterations?: number;
    /** Run read-only: report what it finds and would do, change nothing. */
    observe?: boolean;
    /** Let the worker ask the person one question mid-run; without it a need becomes `blocked`. */
    allowAsk?: boolean;
    /** After the independent review passes, wait for the person to accept before finishing. */
    reviewBeforeDone?: boolean;
  }): Promise<GoalRun>;
  listSchedules(): Promise<GoalSchedule[]>;
  getSchedule(id: string): Promise<GoalSchedule>;
  createSchedule(input: GoalScheduleInput): Promise<GoalSchedule>;
  updateSchedule(id: string, input: GoalScheduleInput): Promise<GoalSchedule>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<GoalSchedule>;
  deleteSchedule(id: string): Promise<void>;
  runSchedule(id: string): Promise<GoalSchedule>;
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
  /** Retry failed, blocked, or checkpoint-limited work under the same Goal and Mandate. */
  retryGoal(thebeSessionId: string): Promise<GoalRun>;
  /** Answer the one open question on a paused Goal, or accept / send back a result waiting for review. */
  answerGoal(
    thebeSessionId: string,
    input: {
      attentionId: string;
      answer?: string;
      decision?: "accept" | "reject";
    }
  ): Promise<GoalRun>;
  /** Add durable guidance for the Goal's next worker checkpoint without interrupting it. */
  addGoalGuidance(thebeSessionId: string, note: string): Promise<GoalRun>;
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
   * only when the host has enabled writes over `/mcp` and the caller may write. The caller is
   * required, so a route that forgets it does not compile instead of quietly allowing writes.
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
  /** Tickets: the authorised units of work. The Goal behind one keeps its status, report and attention. */
  listTickets(): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | undefined>;
  getTicketForGoal(goalId: string): Promise<Ticket | undefined>;
  /** Delegate one direct Ticket and Goal from the person-facing HTTP API. Idempotent by key. */
  delegateTicket(
    input: Record<string, unknown>
  ): Promise<TicketTaskView & { reused: boolean }>;
  /** Answer or review a Ticket's Attention, or resolve one of its pending worker permissions. */
  replyTicket(input: Record<string, unknown>): Promise<TicketTaskView>;
  /** Add guidance for the next checkpoint of a live Ticket. */
  noteTicket(input: Record<string, unknown>): Promise<TicketTaskView>;
  /** Pause, resume, stop, or retry the Goal carrying out a Ticket. */
  controlTicket(input: {
    ticketId: string;
    action: "pause" | "resume" | "stop" | "retry";
  }): Promise<TicketTaskView>;
  /** The rules and mode Eval weighs events by. Changing it never rewrites a past Decision. */
  getPolicy(): Promise<Policy & { modes: string[] }>;
  setPolicy(input: {
    rules?: unknown;
    acceptMode?: unknown;
    model?: unknown;
  }): Promise<Policy & { modes: string[] }>;
  /** What Eval decided, newest first. In observe, `wouldAccept` marks what Core would have taken on. */
  listDecisions(query?: {
    thread?: string;
    limit?: number;
  }): Promise<Decision[]>;
  getDecision(id: string): Promise<Decision | undefined>;
  /** Accept a positive Eval candidate as an explicit Ticket. The original Decision stays immutable. */
  acceptDecision(decisionId: string): Promise<
    TicketTaskView & {
      decisionId: string;
      candidate: false;
      reused: boolean;
    }
  >;
  /** Attach one Decision's events to an explicitly named Ticket without another Eval. */
  attachDecision(input: {
    decisionId: string;
    ticketId: string;
    note?: string;
  }): Promise<
    TicketTaskView & {
      decisionId: string;
      attachedTicketId: string;
      reused: boolean;
    }
  >;
  /** Events the enabled Sources observed, newest first. They feed fan-out and Eval. */
  listTriggers(query?: { thread?: string; limit?: number }): Promise<Trigger[]>;
  /** Read health for each enabled Source, including consecutive failures and the latest error. */
  sourceHealth?(): SourceHealth[];
  /** Records the Ticket for a Goal the person asked for. Idempotent. */
  recordGoalTicket(
    run: GoalRun,
    options?: { threads?: string[] }
  ): Promise<Ticket>;
  /** Attaches a trigger to an open subscribed ticket as an input. Returns ticket ids if attached. */
  attachTrigger?(trigger: Trigger): Promise<string[]>;
  listActivity(group?: ActivityGroup): Promise<ActivityRecord[]>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  denyActivity(id: string): Promise<boolean>;
  listAudit(query?: AuditQuery): Promise<AuditPage>;
  getAudit(id: string): Promise<AuditRecord | undefined>;
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
