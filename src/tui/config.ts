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

export type CustomModelDefinition = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
};

export type CustomProviderOptions = {
  providerId: string;
  name?: string;
  baseUrl: string;
  api:
    | "openai-completions"
    | "openai-responses"
    | "anthropic-messages"
    | "google-generative-ai"
    | string;
  apiKey?: string;
  models: CustomModelDefinition[];
  compat?: Record<string, unknown>;
};

export async function saveCustomProvider(
  options: CustomProviderOptions,
): Promise<void> {
  try {
    const configDir = getThebeConfigDir();
    const current = await loadThebeConfig();
    const providers = current.providers ?? {};
    providers[options.providerId] = {
      baseUrl: options.baseUrl,
    };
    await saveThebeConfig({ providers });

    const agentDir = process.env.THEBE_AGENT_DIR ?? join(configDir, "agent");
    await mkdir(agentDir, { recursive: true });

    // 1. Persist to models.json for native pi ModelRuntime
    const modelsJsonPath = join(agentDir, "models.json");
    let modelsData: Record<string, unknown> = {};
    try {
      modelsData = JSON.parse(await readFile(modelsJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {}
    const existingProviders = (modelsData.providers ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const currentProvider = existingProviders[options.providerId] ?? {};

    // Merge or append models by id
    const existingModels = Array.isArray(currentProvider.models)
      ? [...(currentProvider.models as Array<Record<string, unknown>>)]
      : [];
    for (const newModel of options.models) {
      const idx = existingModels.findIndex((m) => m.id === newModel.id);
      const modelEntry: Record<string, unknown> = {
        id: newModel.id,
        name: newModel.name ?? newModel.id,
        contextWindow: newModel.contextWindow ?? 128000,
        maxTokens: newModel.maxTokens ?? 4096,
        reasoning: Boolean(newModel.reasoning),
      };
      if (idx >= 0) {
        existingModels[idx] = { ...existingModels[idx], ...modelEntry };
      } else {
        existingModels.push(modelEntry);
      }
    }

    const updatedProvider: Record<string, unknown> = {
      ...currentProvider,
      name: options.name ?? currentProvider.name ?? options.providerId,
      baseUrl: options.baseUrl,
      api: options.api,
      models: existingModels,
    };
    if (options.apiKey) {
      updatedProvider.apiKey = options.apiKey;
    }
    if (options.compat) {
      updatedProvider.compat = {
        ...((currentProvider.compat as Record<string, unknown>) ?? {}),
        ...options.compat,
      };
    }
    existingProviders[options.providerId] = updatedProvider;
    modelsData.providers = existingProviders;
    await writeFile(modelsJsonPath, JSON.stringify(modelsData, null, 2), "utf8");

    // 2. Persist credentials to auth.json
    const authJsonPath = join(agentDir, "auth.json");
    let authData: Record<string, unknown> = {};
    try {
      authData = JSON.parse(await readFile(authJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {}
    authData[options.providerId] = {
      type: "api_key",
      key: options.apiKey || "none",
    };
    await writeFile(authJsonPath, JSON.stringify(authData, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {}
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
