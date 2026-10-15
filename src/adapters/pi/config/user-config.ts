import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Official Pi default: compact when usage exceeds contextWindow - reserveTokens. */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export function thebeUserConfigPath(): string {
  return join(process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe"), "config.json");
}

/** API-managed providers live in models.json. Remove the obsolete startup override. */
export function removeLegacyProviderOverride(path: string, providerId: string): void {
  let config: Record<string, any>;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!config.providers || !Object.hasOwn(config.providers, providerId)) return;
  delete config.providers[providerId];
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export function loadThebeUserConfig(): {
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  /** As written in config.json. */
  permissionMode?: string;
  maxSubagentConcurrency?: number;
  maxSubagentsPerParent?: number;
  workspacePath?: string;
  outputDirectory?: string;
  providers?: Record<string, { baseUrl?: string }>;
} {
  try {
    const configPath = thebeUserConfigPath();
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      autoCompact?: boolean;
      autoSummary?: boolean;
      autoSummaryDelayMs?: number;
      permissionMode?: string;
      maxSubagentConcurrency?: number;
      maxSubagentsPerParent?: number;
      workspacePath?: string;
      outputDirectory?: string;
      providers?: Record<string, { baseUrl?: string }>;
    };
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
