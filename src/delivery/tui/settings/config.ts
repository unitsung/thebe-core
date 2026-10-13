import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../../atomic-write.ts";
import type { TuiMode } from "../rendering/adapter.ts";

export type ThebeUserConfig = {
  externalEditor?: string;
  tuiMode?: TuiMode;
  theme?: "dark" | "light";
  defaultThinkingLevel?: string;
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  permissionMode?: "ask" | "read-only" | "full-access";
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  hideThinking?: boolean;
  quietStartup?: boolean;
  fullscreenExitOutput?: "transcript" | "resume-hint";
  fullscreenScrollbar?: "auto" | "always" | "hidden";
  workspacePath?: string;
  outputDirectory?: string;
  providers?: Record<string, { baseUrl?: string }>;
};

export function getThebeConfigDir(): string {
  return (
    process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe")
  );
}

export function getThebeConfigPath(): string {
  return join(getThebeConfigDir(), "config.json");
}
export function getThebeAgentDir(): string {
  return process.env.THEBE_AGENT_DIR ?? join(getThebeConfigDir(), "agent");
}

export async function ensureThebeConfigFile(): Promise<string> {
  const configPath = getThebeConfigPath();
  await mkdir(getThebeConfigDir(), { recursive: true });
  try {
    await writeFile(configPath, "{}\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return configPath;
}

export function getExternalEditorCommand(config: ThebeUserConfig): string {
  const configured = config.externalEditor?.trim();
  return (
    configured ||
    process.env.VISUAL ||
    process.env.EDITOR ||
    (process.platform === "win32" ? "notepad" : "nano")
  );
}

export async function loadThebeConfig(): Promise<ThebeUserConfig> {
  try {
    const parsed = JSON.parse(
      await readFile(getThebeConfigPath(), "utf8")
    ) as ThebeUserConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveThebeConfig(
  patch: Partial<ThebeUserConfig>
): Promise<ThebeUserConfig> {
  try {
    const dir = getThebeConfigDir();
    await mkdir(dir, { recursive: true });
    const updated: ThebeUserConfig = { ...(await loadThebeConfig()), ...patch };
    await writeFileAtomic(
      getThebeConfigPath(),
      JSON.stringify(updated, null, 2),
      "utf8"
    );
    return updated;
  } catch {
    return {};
  }
}
