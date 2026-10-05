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
