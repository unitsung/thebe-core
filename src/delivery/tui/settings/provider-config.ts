import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getThebeAgentDir,
  loadThebeConfig,
  saveThebeConfig,
} from "./config.ts";

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
  options: CustomProviderOptions
): Promise<void> {
  try {
    const current = await loadThebeConfig();
    const providers = current.providers ?? {};
    providers[options.providerId] = { baseUrl: options.baseUrl };
    await saveThebeConfig({ providers });
    const agentDir = getThebeAgentDir();
    await mkdir(agentDir, { recursive: true });

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
    const existingModels = Array.isArray(currentProvider.models)
      ? [...(currentProvider.models as Array<Record<string, unknown>>)]
      : [];
    for (const newModel of options.models) {
      const index = existingModels.findIndex(
        (model) => model.id === newModel.id
      );
      const reasoning =
        newModel.reasoning !== undefined
          ? Boolean(newModel.reasoning)
          : isReasoningModel(newModel.id, newModel.name);
      const modelEntry: Record<string, unknown> = {
        id: newModel.id,
        name: newModel.name ?? newModel.id,
        contextWindow: newModel.contextWindow ?? 128000,
        maxTokens: newModel.maxTokens ?? 4096,
        reasoning,
      };
      if (reasoning)
        modelEntry.thinkingLevelMap = newModel.thinkingLevelMap ?? {
          ...DEFAULT_THINKING_LEVEL_MAP,
        };
      if (index >= 0)
        existingModels[index] = { ...existingModels[index], ...modelEntry };
      else existingModels.push(modelEntry);
    }
    const defaultCompat: Record<string, unknown> = {};
    if (options.api === "openai-completions") {
      defaultCompat.supportsDeveloperRole = false;
      defaultCompat.supportsReasoningEffort = true;
      defaultCompat.thinkingFormat =
        options.providerId.includes("deepseek") ||
        options.baseUrl.includes("deepseek")
          ? "deepseek"
          : options.providerId.includes("qwen") ||
              options.baseUrl.includes("qwen")
            ? "qwen"
            : "openai";
    }
    existingProviders[options.providerId] = {
      ...currentProvider,
      name: options.name ?? currentProvider.name ?? options.providerId,
      baseUrl: options.baseUrl,
      api: options.api,
      models: existingModels,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      compat: {
        ...defaultCompat,
        ...(currentProvider.compat as Record<string, unknown>),
        ...options.compat,
      },
    };
    modelsData.providers = existingProviders;
    await writeFile(
      modelsJsonPath,
      JSON.stringify(modelsData, null, 2),
      "utf8"
    );

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
  baseUrl: string
): Promise<void> {
  try {
    const current = await loadThebeConfig();
    const providers = current.providers ?? {};
    providers[providerId] = { baseUrl };
    await saveThebeConfig({ providers });
    const agentDir = getThebeAgentDir();
    await mkdir(agentDir, { recursive: true });
    const modelsJsonPath = join(agentDir, "models.json");
    let existingJson: Record<string, unknown> = {};
    try {
      existingJson = JSON.parse(
        await readFile(modelsJsonPath, "utf8")
      ) as Record<string, unknown>;
    } catch {}
    const existingProviders = (existingJson.providers ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    existingProviders[providerId] = {
      ...existingProviders[providerId],
      baseUrl,
    };
    existingJson.providers = existingProviders;
    await writeFile(
      modelsJsonPath,
      JSON.stringify(existingJson, null, 2),
      "utf8"
    );
  } catch {}
}

export async function fetchRemoteModels(
  baseUrl: string,
  apiKey?: string,
  api?: string,
  timeoutMs = 4000
): Promise<Array<{ id: string; name?: string }> | null> {
  const cleanUrl = baseUrl.replace(/\/+$/, "");
  const candidateUrls =
    api === "google-generative-ai"
      ? [
          apiKey && apiKey !== "none"
            ? `${cleanUrl}/models?key=${apiKey}`
            : `${cleanUrl}/models`,
        ]
      : cleanUrl.endsWith("/v1")
        ? [
            `${cleanUrl}/models`,
            `${cleanUrl.slice(0, -3)}/models`,
            `${cleanUrl.slice(0, -3)}/api/tags`,
          ]
        : [
            `${cleanUrl}/models`,
            `${cleanUrl}/v1/models`,
            `${cleanUrl}/api/tags`,
          ];
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey && apiKey !== "none" && apiKey !== "placeholder") {
    headers.Authorization = `Bearer ${apiKey}`;
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }
  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as any;
      const list: Array<{ id: string; name?: string }> = [];
      const seen = new Set<string>();
      const addModel = (rawId?: unknown, rawName?: unknown) => {
        if (typeof rawId !== "string") return;
        const id = rawId.trim().replace(/^models\//, "");
        if (!id || seen.has(id)) return;
        seen.add(id);
        list.push({
          id,
          name:
            typeof rawName === "string" && rawName.trim() ? rawName.trim() : id,
        });
      };
      const rawList = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      for (const item of rawList) {
        if (typeof item === "string") addModel(item, item);
        else
          addModel(
            item?.id ?? item?.name ?? item?.model,
            item?.display_name ??
              item?.displayName ??
              item?.name ??
              item?.model ??
              item?.id
          );
      }
      if (list.length) return list;
    } catch {
      // Try the next compatible endpoint.
    }
  }
  return null;
}
