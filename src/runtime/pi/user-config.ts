import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Official Pi default: compact when usage exceeds contextWindow - reserveTokens. */
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export function loadThebeUserConfig(): {
  autoCompact?: boolean;
  providers?: Record<string, { baseUrl?: string }>;
} {
  try {
    const configPath = join(
      process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe"),
      "config.json",
    );
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      autoCompact?: boolean;
      providers?: Record<string, { baseUrl?: string }>;
    };
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
