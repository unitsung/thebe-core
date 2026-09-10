import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuiMode } from "@earendil-works/pi-tui";

export type ThebeUserConfig = {
  tuiMode?: TuiMode;
  theme?: "dark" | "light";
  defaultThinkingLevel?: string;
  autoCompact?: boolean;
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  hideThinking?: boolean;
  quietStartup?: boolean;
  fullscreenExitOutput?: "transcript" | "resume-hint";
  fullscreenScrollbar?: "auto" | "always" | "hidden";
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

export const DEFAULT_THINKING_LEVEL_MAP: Record<string, string | null> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

export type CustomModelDefinition = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
};

export function isReasoningModel(id: string, name?: string): boolean {
  const text = `${id} ${name ?? ""}`.toLowerCase();
  return (
    /\b(r1|o1|o3|o4|qwq)\b/i.test(text) ||
    /[-_](r1|o1|o3|o4)\b/i.test(text) ||
    text.includes("deepseek-r1") ||
    text.includes("reasoner") ||
    text.includes("reasoning") ||
    text.includes("thinking")
  );
}

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
      const isReasoning =
        newModel.reasoning !== undefined
          ? Boolean(newModel.reasoning)
          : isReasoningModel(newModel.id, newModel.name);
      const modelEntry: Record<string, unknown> = {
        id: newModel.id,
        name: newModel.name ?? newModel.id,
        contextWindow: newModel.contextWindow ?? 128000,
        maxTokens: newModel.maxTokens ?? 4096,
        reasoning: isReasoning,
      };
      if (isReasoning) {
        modelEntry.thinkingLevelMap = newModel.thinkingLevelMap ?? {
          ...DEFAULT_THINKING_LEVEL_MAP,
        };
      }
      if (idx >= 0) {
        existingModels[idx] = { ...existingModels[idx], ...modelEntry };
      } else {
        existingModels.push(modelEntry);
      }
    }

    const defaultCompat: Record<string, unknown> = {};
    if (options.api === "openai-completions") {
      defaultCompat.supportsDeveloperRole = false;
      defaultCompat.supportsReasoningEffort = true;
      if (
        options.providerId.includes("deepseek") ||
        options.baseUrl.includes("deepseek")
      ) {
        defaultCompat.thinkingFormat = "deepseek";
      } else if (
        options.providerId.includes("qwen") ||
        options.baseUrl.includes("qwen")
      ) {
        defaultCompat.thinkingFormat = "qwen";
      } else {
        defaultCompat.thinkingFormat = "openai";
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
    updatedProvider.compat = {
      ...defaultCompat,
      ...((currentProvider.compat as Record<string, unknown>) ?? {}),
      ...(options.compat ?? {}),
    };
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

export async function fetchRemoteModels(
  baseUrl: string,
  apiKey?: string,
  api?: string,
  timeoutMs = 4000,
): Promise<Array<{ id: string; name?: string }> | null> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const candidateUrls: string[] = [];

  if (api === "google-generative-ai") {
    candidateUrls.push(
      apiKey && apiKey !== "none"
        ? `${cleanUrl}/models?key=${apiKey}`
        : `${cleanUrl}/models`,
    );
  } else {
    candidateUrls.push(`${cleanUrl}/models`);
    if (cleanUrl.endsWith("/v1")) {
      candidateUrls.push(`${cleanUrl.slice(0, -3)}/models`);
      candidateUrls.push(`${cleanUrl.slice(0, -3)}/api/tags`);
    } else {
      candidateUrls.push(`${cleanUrl}/v1/models`);
      candidateUrls.push(`${cleanUrl}/api/tags`);
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey && apiKey !== "none" && apiKey !== "placeholder") {
    headers.Authorization = `Bearer ${apiKey}`;
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as any;
      const list: Array<{ id: string; name?: string }> = [];
      const seen = new Set<string>();

      const addModel = (rawId?: unknown, rawName?: unknown) => {
        if (!rawId || typeof rawId !== "string") return;
        let id = rawId.trim();
        if (id.startsWith("models/")) {
          id = id.slice("models/".length);
        }
        if (!id || seen.has(id)) return;
        seen.add(id);
        const name =
          typeof rawName === "string" && rawName.trim()
            ? rawName.trim()
            : id;
        list.push({ id, name });
      };

      if (Array.isArray(data?.data)) {
        for (const item of data.data) {
          if (typeof item === "string") {
            addModel(item, item);
          } else {
            addModel(item?.id ?? item?.name, item?.display_name ?? item?.name ?? item?.id);
          }
        }
      } else if (Array.isArray(data?.models)) {
        for (const item of data.models) {
          if (typeof item === "string") {
            addModel(item, item);
          } else {
            addModel(item?.id ?? item?.name ?? item?.model, item?.displayName ?? item?.name ?? item?.model ?? item?.id);
          }
        }
      } else if (Array.isArray(data)) {
        for (const item of data) {
          if (typeof item === "string") {
            addModel(item, item);
          } else {
            addModel(item?.id ?? item?.name ?? item?.model, item?.displayName ?? item?.display_name ?? item?.name ?? item?.id);
          }
        }
      }

      if (list.length > 0) {
        return list;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
