import type { SelectItem, TUI } from "../rendering/adapter.ts";
import type { ThebeAgent } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import { attachPromptInput, attachSelectList } from "../overlays/index.ts";
import {
  saveCustomProvider,
  fetchRemoteModels,
  isReasoningModel,
  DEFAULT_THINKING_LEVEL_MAP,
} from "../settings/provider-config.ts";

export type CustomProviderWizardDeps = {
  tui: TUI;
  editor: unknown;
  agent: ThebeAgent;
  notice: (text: string) => void;
  getActiveSelectListTheme: () => import("../rendering/adapter.ts").SelectListTheme;
};

export async function runCustomProviderWizard(
  deps: CustomProviderWizardDeps,
  initialProviderId?: string,
): Promise<{ providerId: string; modelId: string } | null> {
  const { tui, editor, agent, notice, getActiveSelectListTheme } = deps;

  // 1. Choose API Protocol format (OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google)
  const apiChoices = [
    {
      label: "1. OpenAI Chat Completions (openai-completions)",
      value: "openai-completions",
      hint: "Ollama, vLLM, DeepSeek, LM Studio, OneAPI, proxies",
    },
    {
      label: "2. OpenAI Responses (openai-responses)",
      value: "openai-responses",
      hint: "OpenAI Responses API endpoint (/responses)",
    },
    {
      label: "3. Anthropic Messages (anthropic-messages)",
      value: "anthropic-messages",
      hint: "Anthropic Messages API (/v1/messages, Claude proxies)",
    },
    {
      label: "4. Google Generative AI (google-generative-ai)",
      value: "google-generative-ai",
      hint: "Google Gemini API (/v1beta, AI Studio)",
    },
  ];

  const chosenApi = await attachSelectList(
    tui,
    apiChoices.map((c) => ({
      label: `${c.label}  ${chalk.dim(c.hint)}`,
      value: c.value,
    })),
    editor,
    undefined,
    getActiveSelectListTheme(),
  );
  if (!chosenApi) {
    notice("custom endpoint setup cancelled");
    return null;
  }
  const api = chosenApi.value;

  // 2. Base URL endpoint
  let defaultPlaceholder = "https://api.deepseek.com/v1";
  if (api === "openai-completions") {
    defaultPlaceholder = "https://api.deepseek.com/v1 (or http://localhost:11434/v1)";
  } else if (api === "openai-responses") {
    defaultPlaceholder = "https://api.openai.com/v1";
  } else if (api === "anthropic-messages") {
    defaultPlaceholder = "https://api.anthropic.com";
  } else if (api === "google-generative-ai") {
    defaultPlaceholder = "https://generativelanguage.googleapis.com/v1beta";
  }

  const endpoint = await attachPromptInput(tui, {
    prompt: chalk.cyan("Base URL endpoint: "),
    placeholder: defaultPlaceholder,
    focusBack: editor,
  });
  if (endpoint === null) {
    notice("custom endpoint setup cancelled");
    return null;
  }
  if (!endpoint.trim()) {
    notice("custom endpoint setup cancelled (Base URL is required)");
    return null;
  }
  const baseUrl = endpoint.trim().replace(/\/+$/, "");

  // 3. Provider ID / Name
  const suggestedId =
    initialProviderId && initialProviderId !== "custom"
      ? initialProviderId
      : baseUrl.includes("deepseek")
        ? "deepseek"
        : baseUrl.includes("ollama") || baseUrl.includes("11434")
          ? "ollama"
          : baseUrl.includes("moonshot") || baseUrl.includes("kimi")
            ? "moonshot"
            : baseUrl.includes("qwen")
              ? "qwen"
              : "custom";

  const providerInput = await attachPromptInput(tui, {
    prompt: chalk.cyan(`Provider ID [default: ${suggestedId}]: `),
    placeholder: suggestedId,
    focusBack: editor,
  });
  if (providerInput === null) {
    notice("custom endpoint setup cancelled");
    return null;
  }
  const providerId = (providerInput.trim() || suggestedId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");

  // 4. API Key
  const keyInput = await attachPromptInput(tui, {
    prompt: chalk.cyan(
      "API key (optional for local/keyless servers, press Enter to skip): ",
    ),
    placeholder: "sk-... or press Enter if keyless",
    focusBack: editor,
  });
  if (keyInput === null) {
    notice("custom endpoint setup cancelled");
    return null;
  }
  const apiKey = keyInput.trim() || "none";

  // 5. Model Selection (Auto-fetch from endpoint with manual fallback)
  let suggestedModel = "custom-model";
  if (providerId.includes("deepseek") || baseUrl.includes("deepseek")) {
    suggestedModel = "deepseek-chat";
  } else if (providerId.includes("ollama") || baseUrl.includes("11434")) {
    suggestedModel = "llama3.1";
  } else if (api === "anthropic-messages") {
    suggestedModel = "claude-3-7-sonnet";
  } else if (api === "openai-responses") {
    suggestedModel = "gpt-4o";
  }

  notice("fetching available models from endpoint...");
  tui.requestRender();

  const remoteModels = await fetchRemoteModels(baseUrl, apiKey, api);
  let selectedModelId = "";

  if (remoteModels && remoteModels.length > 0) {
    notice(`discovered ${remoteModels.length} models from endpoint`);
    const selectItems: SelectItem[] = remoteModels.map((m) => ({
      label: m.name && m.name !== m.id ? `${m.id} (${m.name})` : m.id,
      value: m.id,
    }));
    selectItems.push({
      label: chalk.dim("+ Enter model ID manually..."),
      value: "__manual__",
    });

    const chosenModel = await attachSelectList(
      tui,
      selectItems,
      editor,
      undefined,
      getActiveSelectListTheme(),
    );
    if (!chosenModel) {
      notice("custom endpoint setup cancelled");
      return null;
    }
    if (chosenModel.value === "__manual__") {
      const modelInput = await attachPromptInput(tui, {
        prompt: chalk.cyan(`Model ID [default: ${suggestedModel}]: `),
        placeholder: suggestedModel,
        focusBack: editor,
      });
      if (modelInput === null) {
        notice("custom endpoint setup cancelled");
        return null;
      }
      selectedModelId = modelInput.trim() || suggestedModel;
    } else {
      selectedModelId = chosenModel.value;
    }
  } else {
    const modelInput = await attachPromptInput(tui, {
      prompt: chalk.cyan(`Model ID [default: ${suggestedModel}]: `),
      placeholder: suggestedModel,
      focusBack: editor,
    });
    if (modelInput === null) {
      notice("custom endpoint setup cancelled");
      return null;
    }
    selectedModelId = modelInput.trim() || suggestedModel;
  }

  // Ask user whether to enable thinking / reasoning capability for this model
  const defaultReasoning = isReasoningModel(selectedModelId);
  const reasoningPrompt = defaultReasoning
    ? `Enable thinking/reasoning for ${selectedModelId}? [Y/n]: `
    : `Enable thinking/reasoning for ${selectedModelId}? [y/N]: `;
  const reasoningInput = await attachPromptInput(tui, {
    prompt: chalk.cyan(reasoningPrompt),
    placeholder: defaultReasoning ? "y" : "n",
    focusBack: editor,
  });
  if (reasoningInput === null) {
    notice("custom endpoint setup cancelled");
    return null;
  }
  const trimmedReasoning = reasoningInput.trim().toLowerCase();
  const enableReasoning = defaultReasoning
    ? trimmedReasoning !== "n" && trimmedReasoning !== "no"
    : trimmedReasoning === "y" || trimmedReasoning === "yes";

  // 6. Save to models.json, auth.json, config.json
  const modelsToSave =
    remoteModels && remoteModels.length > 0
      ? remoteModels.map((m) => {
          const reasoning = isReasoningModel(m.id, m.name);
          return {
            id: m.id,
            name: m.name || m.id,
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning,
            thinkingLevelMap: reasoning
              ? { ...DEFAULT_THINKING_LEVEL_MAP }
              : undefined,
          };
        })
      : [];

  const existingSelected = modelsToSave.find((m) => m.id === selectedModelId);
  if (existingSelected) {
    existingSelected.reasoning = enableReasoning;
    existingSelected.thinkingLevelMap = enableReasoning
      ? { ...DEFAULT_THINKING_LEVEL_MAP }
      : undefined;
  } else {
    modelsToSave.unshift({
      id: selectedModelId,
      name: selectedModelId,
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: enableReasoning,
      thinkingLevelMap: enableReasoning
        ? { ...DEFAULT_THINKING_LEVEL_MAP }
        : undefined,
    });
  }

  await saveCustomProvider({
    providerId,
    name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
    baseUrl,
    api,
    apiKey,
    models: modelsToSave,
  });

  // 7. Update runtime auth credentials
  try {
    await agent.auth().setApiKey(providerId, apiKey);
  } catch {}

  return { providerId, modelId: selectedModelId };
}
