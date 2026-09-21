import type {
  EnabledResource,
  PermissionMode,
} from "../runtime/interface.ts";

export const DEFAULT_AGENT_AUTO_COMPACT = true;
export const DEFAULT_AGENT_AUTO_SUMMARY = true;
export const DEFAULT_AGENT_AUTO_SUMMARY_DELAY_MS = 120_000;
export const MIN_AGENT_AUTO_SUMMARY_DELAY_MS = 60_000;
export const MAX_AGENT_AUTO_SUMMARY_DELAY_MS = 15 * 60_000;
export const DEFAULT_AGENT_MAX_SUBAGENT_CONCURRENCY = 3;
export const DEFAULT_AGENT_MAX_SUBAGENTS_PER_PARENT = 2;
export const MIN_AGENT_SUBAGENT_CONCURRENCY = 1;
export const MAX_AGENT_SUBAGENT_CONCURRENCY = 16;

export const AGENT_SETTING_KEYS = [
  "autoCompact",
  "autoSummary",
  "autoSummaryDelayMs",
  "permissionMode",
  "maxSubagentConcurrency",
  "maxSubagentsPerParent",
  "workspacePath",
  "outputDirectory",
] as const;

export type AgentSettingKey = (typeof AGENT_SETTING_KEYS)[number];
export type AgentSettingSource =
  | "configured"
  | "default"
  | "environment"
  | "derived";

export type AgentSettings = {
  autoCompact: boolean;
  autoSummary: boolean;
  autoSummaryDelayMs: number;
  permissionMode: PermissionMode;
  maxSubagentConcurrency: number;
  maxSubagentsPerParent: number;
  workspacePath?: string;
  outputDirectory?: string;
  sources: Record<AgentSettingKey, AgentSettingSource>;
  persistence: {
    enabled: boolean;
  };
  mutable: readonly ["autoCompact", "autoSummary", "autoSummaryDelayMs"];
};

export type AgentSettingsPatch = Partial<Pick<
  AgentSettings,
  "autoCompact" | "autoSummary" | "autoSummaryDelayMs"
>>;

export type AgentSettingsValues = Partial<{
  autoCompact: boolean;
  autoSummary: boolean;
  autoSummaryDelayMs: number;
  permissionMode: PermissionMode;
  maxSubagentConcurrency: number;
  maxSubagentsPerParent: number;
  workspacePath: string;
  outputDirectory: string;
  enabledResources: EnabledResource[];
}>;

export type AgentSettingsStore = {
  load(): AgentSettingsValues;
  save(patch: AgentSettingsValues): void | Promise<void>;
};

export function normalizeAgentAutoSummaryDelay(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENT_AUTO_SUMMARY_DELAY_MS;
  return Math.min(
    MAX_AGENT_AUTO_SUMMARY_DELAY_MS,
    Math.max(MIN_AGENT_AUTO_SUMMARY_DELAY_MS, Math.round(value as number)),
  );
}

export function normalizeAgentSubagentLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(
    MIN_AGENT_SUBAGENT_CONCURRENCY,
    Math.min(MAX_AGENT_SUBAGENT_CONCURRENCY, Math.floor(value as number)),
  );
}
