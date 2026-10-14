import type { RuntimeModel } from "../../../agent/runtime/interface.ts";

export type PiModelShape = {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  thinkingLevelMap?: unknown;
};

export function toRuntimeModel(
  model: PiModelShape,
  availableIds?: Set<string>,
): RuntimeModel {
  return {
    providerId: model.provider,
    modelId: model.id,
    displayName: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsThinking:
      model.reasoning === true || model.thinkingLevelMap != null || undefined,
    supportsImages: model.input?.includes("image"),
    available: availableIds ? availableIds.has(modelKey(model)) : undefined,
  };
}

export function modelKey(model: PiModelShape): string {
  return `${model.provider}/${model.id}`;
}

export function resolveModelRef(
  getModel: (providerId: string, modelId: string) => unknown,
  providerId: string,
  modelId: string,
): PiModelShape | undefined {
  return getModel(providerId, modelId) as PiModelShape | undefined;
}

/**
 * Pi fills a model that has no size in `models.json` with 128000 / 16384. After one discovery round
 * trip those invented numbers sit in the saved configuration next to real ones, so a client could not
 * tell a reported window from a placeholder. The exact default pair is therefore reported as unknown.
 */
const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
const PI_DEFAULT_MAX_TOKENS = 16_384;

export function withoutPlaceholderLimits<T extends { contextWindow?: number; maxOutputTokens?: number }>(model: T): T {
  if (model.contextWindow === PI_DEFAULT_CONTEXT_WINDOW && model.maxOutputTokens === PI_DEFAULT_MAX_TOKENS) {
    return { ...model, contextWindow: undefined, maxOutputTokens: undefined };
  }
  return model;
}
