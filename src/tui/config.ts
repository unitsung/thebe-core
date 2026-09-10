import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiMode } from "@earendil-works/pi-tui";

export type ThebeUserConfig = {
  tuiMode?: TuiMode;
  theme?: "dark" | "light";
  providers?: Record<string, { baseUrl?: string }>;
};

export function getThebeConfigDir(): string {
  return (
    process.env.THEBE_CONFIG_DIR ??
    join(process.env.HOME ?? ".", ".thebe")
  );
}

export function getThebeConfigPath(): string {
  return join(getThebeConfigDir(), "config.json");
}

export async function loadThebeConfig(): Promise<ThebeUserConfig> {
  try {
    const raw = await readFile(getThebeConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as ThebeUserConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveThebeConfig(
  patch: Partial<ThebeUserConfig>,
): Promise<ThebeUserConfig> {
  try {
    const dir = getThebeConfigDir();
    await mkdir(dir, { recursive: true });
    const current = await loadThebeConfig();
    const updated: ThebeUserConfig = { ...current, ...patch };
    await writeFile(
      getThebeConfigPath(),
      JSON.stringify(updated, null, 2),
      "utf8",
    );
    return updated;
  } catch {
    return {};
  }
}

export async function saveProviderEndpoint(
  providerId: string,
  baseUrl: string,
): Promise<void> {
  try {
    const current = await loadThebeConfig();
    const providers = current.providers ?? {};
    providers[providerId] = { baseUrl };
    await saveThebeConfig({ providers });

    // Also persist to models.json for pi ModelRuntime
    const configDir = getThebeConfigDir();
    const agentDir = process.env.THEBE_AGENT_DIR ?? join(configDir, "agent");
    await mkdir(agentDir, { recursive: true });
    const modelsJsonPath = join(agentDir, "models.json");
    let existingJson: Record<string, unknown> = {};
    try {
      existingJson = JSON.parse(await readFile(modelsJsonPath, "utf8")) as Record<string, unknown>;
    } catch {}
    const existingProviders = (existingJson.providers ?? {}) as Record<string, Record<string, unknown>>;
    existingProviders[providerId] = {
      ...(existingProviders[providerId] ?? {}),
      baseUrl,
    };
    existingJson.providers = existingProviders;
    await writeFile(modelsJsonPath, JSON.stringify(existingJson, null, 2), "utf8");
  } catch {}
}
