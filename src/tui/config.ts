import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiMode } from "@earendil-works/pi-tui";

export type ThebeUserConfig = {
  tuiMode?: TuiMode;
  theme?: "dark" | "light";
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
