import type {
  AgentRuntime,
  BackgroundTask,
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
  RuntimeThinkingInfo,
  ThebeSessionContext,
} from "./runtime/index.ts";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
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
import type { AuditPage, AuditQuery } from "./security/audit/audit-log.ts";
import type { SubagentProfile } from "./subagents/catalog.ts";
import type {
  GoalRun,
  SessionRunStatus,
  SubagentRun,
  SubagentUpdate,
  ThebePromptOptions,
  ThebePromptResult,
} from "./types.ts";
import type {
  DiagnosisRequest,
  DiagnosisResult,
} from "./diagnosis/types.ts";
import type { ActionReceipt, ActionRequest } from "./action/types.ts";
import type { ActivityGroup, ActivityRecord } from "./activity/types.ts";
import type {
  AgentArtifact,
  ArtifactContent,
  ArtifactQuery,
} from "./artifacts/types.ts";
import type { ArtifactStore } from "./artifacts/store.ts";
import type { ProductBackgroundTask } from "./background-tasks/product.ts";
import type { JudgmentModel } from "./judgment/interface.ts";
import type { JudgmentEnabledSites } from "./judgment/types.ts";
import type {
  AgentSettings,
  AgentSettingsPatch,
  AgentSettingsStore,
} from "./settings/product.ts";

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
  now?: () => Date;
  callerId?: string;
  maxToolCalls?: number;
  maxBlocks?: number;
  ttfbMs?: number;
  idleMs?: number;
  watchdogMs?: number;
  toolWatchdogMs?: number;
  sessionIdleTimeoutMs?: number;
  systemPrompt?: string;
  builtinTools?: readonly string[];
  enabledResources?: EnabledResource[];
  model?: RuntimeModelRef;
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  permissionMode?: PermissionMode;
  maxSubagentConcurrency?: number;
  maxSubagentsPerParent?: number;
  workspacePath?: string;
  outputDirectory?: string;
  /** External MCP capability supplied by the composition root. */
  mcp?: McpRegistry;
  /** Optional provider-owned STRM repair write boundary. */
  strmRepairProvider?: StrmRepairProvider;
  /** Optional Judgment Model. Absent means the Judgment Gate is off. */
  judgment?: JudgmentModel;
  /** Which catalog Sites may call the model. Default all when a model is present. */
  judgmentSites?: JudgmentEnabledSites;
  /** Optional persistence boundary for product-facing Agent settings. */
  settingsStore?: AgentSettingsStore;
  /** Optional persistence boundary for product-facing Artifacts. */
  artifactStore?: ArtifactStore;
};

/** Stable agent seam consumed by CLI, Serve, TUI, and integrations. */
export interface ThebeAgent {
  readonly runtime: AgentRuntime;
  readonly workspacePath: string | undefined;

  prompt(input: string | PromptInput, options?: ThebePromptOptions): Promise<ThebePromptResult>;
  send(text: string, thebeSessionId?: string): Promise<ThebePromptResult>;
  toolNames(): string[];
  lastThebeSessionId(): string | undefined;
  lastEvents(): NormalizedEvent[];
  events(thebeSessionId?: string): NormalizedEvent[];
  subscribeLog(thebeSessionId: string, listener: (event: NormalizedEvent) => void): () => void;
  messages(): RuntimeMessage[];
  loadMessages(thebeSessionId: string): Promise<RuntimeMessage[]>;
  message(thebeSessionId: string, messageId: string): Promise<RuntimeMessage | undefined>;
  isStreaming(thebeSessionId: string): boolean;
  isBusy(thebeSessionId: string): boolean;
  emitLog(thebeSessionId: string, event: NormalizedEvent): void;
  recentEvents(limit?: number): Array<NormalizedEvent & { thebeSessionId: string }>;

  createSession(init?: CreateSessionInput): Promise<AgentSessionMeta>;
  listSessions(query?: { status?: string; hostId?: string; environmentId?: string }): Promise<ThebeSession[]>;
  getSession(thebeSessionId: string): Promise<AgentSessionMeta>;
  patchSession(thebeSessionId: string, patch: Partial<Pick<AgentSessionMeta, "title" | "labels" | "selectedContext" | "shareMetadata" | "rememberedPermissions">>): Promise<AgentSessionMeta>;
  deleteSession(thebeSessionId: string): Promise<void>;
  sessionStatus(): Promise<ThebeSession[]>;
  resume(thebeSessionId: string): Promise<AgentSessionMeta>;
  fork(thebeSessionId?: string, options?: string | { atEntryId?: string; mode?: ForkSessionOptions["mode"] }): Promise<AgentSessionMeta>;
  children(thebeSessionId: string): Promise<AgentSessionMeta[]>;
  compact(thebeSessionId?: string, customInstructions?: string): Promise<void>;
  setAutoCompactionEnabled(thebeSessionId: string | undefined, enabled: boolean): Promise<void>;
  setAutoSummaryEnabled(enabled: boolean): Promise<void>;
  autoSummaryEnabled(): boolean;
  setAutoSummaryDelayMs(delayMs: number): Promise<void>;
  autoSummaryDelayMs(): number;
  interrupt(thebeSessionId?: string): Promise<void>;
  revert(thebeSessionId?: string): Promise<void>;
  unrevert(thebeSessionId?: string): Promise<void>;
  resolvePermission(thebeSessionId: string, permissionId: string, decision: PermissionResolution): Promise<void>;
  pendingPermissionIds(): string[];
  listPendingPermissions(): ProductPendingPermission[];
  getPendingPermission(id: string): ProductPendingPermission | undefined;
  resolvePendingPermission(id: string, decision: PermissionResolution): Promise<void>;
  setModel(thebeSessionId: string, model: RuntimeModelRef): Promise<void>;
  setThinkingLevel(thebeSessionId: string, level: import("./runtime/interface.ts").ThinkingLevel): Promise<RuntimeThinkingInfo>;
  getThinkingInfo(thebeSessionId: string): Promise<RuntimeThinkingInfo>;

  listSkills(): Promise<SkillInfo[]>;
  getSkill(name: string): Promise<SkillInfo | undefined>;
  enableSkill(name: string): Promise<void>;
  disableSkill(name: string): Promise<void>;
  listCapabilities(): Promise<HomelabCapability[]>;
  listMcpTools(): Promise<McpToolInfo[]>;
  listMcpServers(): Promise<McpServerInfo[]>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<McpServerInfo | undefined>;
  closeMcp(): void;
  listSubagentProfiles(): Promise<SubagentProfile[]>;
  spawnSubagent(input: { profileName: string; taskPrompt: string; parentSessionId: string }): Promise<SubagentRun>;
  listSubagents(parentSessionId?: string): Promise<SubagentRun[]>;
  restoreSubagents(parentSessionId: string, restoredRuns: SubagentRun[]): void;
  getSubagent(runId: string): SubagentRun | undefined;
  subscribeSubagent(runId: string, listener: (update: SubagentUpdate) => void): () => void;
  subscribeSubagents(parentSessionId: string | undefined, listener: (update: SubagentUpdate) => void): () => void;
  waitSubagent(runId: string): Promise<SubagentRun>;
  cancelSubagent(runId: string, parentSessionId?: string): Promise<SubagentRun>;
  getForkMessages(thebeSessionId?: string): Promise<Array<{ entryId: string; text: string }>>;
  enableResource(resource: EnabledResource): Promise<void>;
  putEnabledResource(resource: EnabledResource): Promise<EnabledResource>;
  removeEnabledResource(identity: string): Promise<boolean>;
  enabledResources(): EnabledResource[];

  startGoal(input: { thebeSessionId: string; goal: string; criteria?: string[]; maxIterations?: number }): Promise<GoalRun>;
  getGoal(thebeSessionId: string): GoalRun | undefined;
  listGoals(): Promise<GoalRun[]>;
  goalEvents(thebeSessionId: string): Array<{ event: GoalEvent; at: string }>;
  restoreGoal(run: GoalRun | undefined): void;
  subscribeGoal(thebeSessionId: string, listener: (event: GoalEvent) => void): () => void;
  waitGoal(thebeSessionId: string): Promise<GoalRun>;
  pauseGoal(thebeSessionId: string): Promise<GoalRun>;
  resumeGoal(thebeSessionId: string): Promise<GoalRun>;
  stopGoal(thebeSessionId: string): Promise<GoalRun>;
  clearGoal(thebeSessionId: string): void;

  permissionMode(): PermissionMode;
  setPermissionMode(mode: PermissionMode): void;
  updatePermissionMode(mode: PermissionMode): Promise<PermissionMode>;
  getAgentSettings(): AgentSettings;
  updateAgentSettings(patch: AgentSettingsPatch): Promise<AgentSettings>;
  listModels(query?: { all?: boolean; providerId?: string }): Promise<RuntimeModel[]>;
  testModel(model: RuntimeModelRef, query?: { timeoutMs?: number }): Promise<{ providerId: string; modelId: string; text: string; latencyMs: number }>;
  listAvailableModels(query?: { providerId?: string }): Promise<RuntimeModel[]>;
  listProviders(query?: { all?: boolean }): Promise<RuntimeProvider[]>;
  exportSession(thebeSessionId?: string): Promise<RuntimeExport>;
  invokeTool(name: string, args: unknown): Promise<string>;
  invokeCapability(id: string, input?: CapabilityInvokeInput): Promise<CapabilityInvokeResult>;
  getCapabilityRun(runId: string): Promise<CapabilityRun | undefined>;
  listCapabilityRuns(): Promise<CapabilityRun[]>;
  subscribeCapabilityRun(runId: string, listener: (run: CapabilityRun) => void): () => void;
  diagnose(request: DiagnosisRequest): Promise<DiagnosisResult>;
  getDiagnosis(runId: string): Promise<DiagnosisResult | undefined>;
  explainDiagnosis(runId: string, question?: string): Promise<DiagnosisResult>;
  executeApprovedAction(request: ActionRequest): Promise<ActionReceipt>;
  getReceipt(receiptId: string): Promise<ActionReceipt | undefined>;
  listArtifacts(query?: ArtifactQuery): Promise<AgentArtifact[]>;
  getArtifact(artifactId: string): Promise<AgentArtifact | undefined>;
  getArtifactContent(artifactId: string): Promise<ArtifactContent | undefined>;
  listActivity(group?: ActivityGroup): Promise<ActivityRecord[]>;
  getActivity(id: string): Promise<ActivityRecord | undefined>;
  denyActivity(id: string): Promise<boolean>;
  listAudit(query?: AuditQuery): Promise<AuditPage>;
  getContext(thebeSessionId: string): Promise<ThebeSessionContext>;
  getContextUsage(thebeSessionId: string): Promise<ThebeSessionContext>;
  stopToolCall(thebeSessionId: string, toolCallId: string): Promise<void>;
  listBackgroundTasks(thebeSessionId: string): Promise<BackgroundTask[]>;
  listAllBackgroundTasks(): Promise<ProductBackgroundTask[]>;
  stopBackgroundTask(thebeSessionId: string, taskId: string): Promise<void>;
  stopAllBackgroundTasks(thebeSessionId: string): Promise<void>;
  executeBash(thebeSessionId: string, command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ exitCode?: number; cancelled: boolean; output: string }>;
  quiesce(): Promise<void>;
  unquiesce(): Promise<void>;
  reapIdleSessions(idleMs?: number): Promise<{ reaped: number }>;
  isQuiesced(): boolean;
  auth(): RuntimeAuth;
}

export type { ContainerInfoProvider };
