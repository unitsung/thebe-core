import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ENABLED_RESOURCE_KINDS,
  type EnabledResource,
  parsePermissionMode,
} from "../runtime/interface.ts";
import type { AgentSettingsStore, AgentSettingsValues } from "./product.ts";
import type { McpServerState } from "../extensions/mcp.ts";

const SETTING_KEYS = [
  "autoCompact",
  "autoSummary",
  "autoSummaryDelayMs",
  "permissionMode",
  "maxSubagentConcurrency",
  "maxSubagentsPerParent",
  "workspacePath",
  "outputDirectory",
  "instructions",
  "sandboxEnabled",
  "sandboxAllowedDomains",
  "sandboxDeniedDomains",
  "enabledResources",
  "mcpServerStates",
] as const;

/**
 * Persist product settings in Thebe's user config without discarding
 * delivery-specific settings or provider configuration stored beside them.
 */
export function createJsonAgentSettingsStore(path: string): AgentSettingsStore {
  return {
    load(): AgentSettingsValues {
      return pickSettings(readConfig(path));
    },
    save(patch: AgentSettingsValues): void {
      // Never replace a file that exists but cannot be read: that would drop
      // providers and delivery settings stored beside these keys.
      const current = readConfigForUpdate(path);
      const next: Record<string, unknown> = { ...current };
      for (const key of SETTING_KEYS) {
        if (patch[key] !== undefined) next[key] = patch[key];
      }
      mkdirSync(dirname(path), { recursive: true });
      const temporaryPath = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
      );
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(next, null, 2)}\n`,
        "utf8"
      );
      renameSync(temporaryPath, path);
    },
  };
}

function readConfig(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readConfigForUpdate(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Refusing to overwrite ${path}: the file is not valid JSON`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `Refusing to overwrite ${path}: the file does not hold a JSON object`
    );
  }
  return parsed;
}

function pickSettings(config: Record<string, unknown>): AgentSettingsValues {
  const values: AgentSettingsValues = {};
  if (typeof config.autoCompact === "boolean")
    values.autoCompact = config.autoCompact;
  if (typeof config.autoSummary === "boolean")
    values.autoSummary = config.autoSummary;
  if (
    typeof config.autoSummaryDelayMs === "number" &&
    Number.isFinite(config.autoSummaryDelayMs)
  ) {
    values.autoSummaryDelayMs = config.autoSummaryDelayMs;
  }
  const permissionMode = parsePermissionMode(config.permissionMode);
  if (permissionMode) values.permissionMode = permissionMode;
  if (
    typeof config.maxSubagentConcurrency === "number" &&
    Number.isFinite(config.maxSubagentConcurrency)
  ) {
    values.maxSubagentConcurrency = config.maxSubagentConcurrency;
  }
  if (
    typeof config.maxSubagentsPerParent === "number" &&
    Number.isFinite(config.maxSubagentsPerParent)
  ) {
    values.maxSubagentsPerParent = config.maxSubagentsPerParent;
  }
  if (typeof config.workspacePath === "string")
    values.workspacePath = config.workspacePath;
  if (typeof config.outputDirectory === "string")
    values.outputDirectory = config.outputDirectory;
  if (typeof config.instructions === "string")
    values.instructions = config.instructions;
  if (typeof config.sandboxEnabled === "boolean")
    values.sandboxEnabled = config.sandboxEnabled;
  if (Array.isArray(config.sandboxAllowedDomains)) {
    values.sandboxAllowedDomains = config.sandboxAllowedDomains.filter(
      (item): item is string => typeof item === "string"
    );
  }
  if (Array.isArray(config.sandboxDeniedDomains)) {
    values.sandboxDeniedDomains = config.sandboxDeniedDomains.filter(
      (item): item is string => typeof item === "string"
    );
  }
  if (Array.isArray(config.enabledResources)) {
    values.enabledResources = config.enabledResources.filter(isEnabledResource);
  }
  if (Array.isArray(config.mcpServerStates)) {
    values.mcpServerStates = config.mcpServerStates.filter(isMcpServerState);
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnabledResource(value: unknown): value is EnabledResource {
  if (!isRecord(value)) return false;
  return (
    typeof value.identity === "string" &&
    value.identity.trim().length > 0 &&
    typeof value.version === "string" &&
    value.version.trim().length > 0 &&
    typeof value.source === "string" &&
    value.source.trim().length > 0 &&
    ENABLED_RESOURCE_KINDS.some((kind) => kind === value.kind)
  );
}

function isMcpServerState(value: unknown): value is McpServerState {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.enabled === "boolean"
  );
}
