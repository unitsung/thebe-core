import type { RuntimeModel } from "../../types.ts";

export type PiModelShape = {
  id: string;
  provider: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
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
    available: availableIds ? availableIds.has(model.id) : undefined,
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
  let actualModelId = modelId;
  if (providerId === "opencode") {
    if (modelId === "muse-spark-1.3-free" || modelId === "muse-spark-1.3") {
      actualModelId = "muse-spark-1.3-contributor-free";
    } else if (
      modelId === "muse-spark-1.2-free" ||
      modelId === "muse-spark-1.2"
    ) {
      actualModelId = "muse-spark-1.2-contributor-free";
    }
  }
  let found = getModel(providerId, actualModelId);
  if (!found && actualModelId.endsWith("-free")) {
    found = getModel(
      providerId,
      actualModelId.replace(/-free$/, "-contributor-free"),
    );
  }
  if (!found) {
    found = getModel(providerId, modelId);
  }
  return found as PiModelShape | undefined;
}

/** Surface the contributor-free model as muse-spark-1.3-free when needed. */
export function ensureOpencodeFreeAlias(list: RuntimeModel[]): RuntimeModel[] {
  const contributor = list.find(
    (m) =>
      m.providerId === "opencode" &&
      m.modelId === "muse-spark-1.3-contributor-free",
  );
  const hasFree = list.some(
    (m) => m.providerId === "opencode" && m.modelId === "muse-spark-1.3-free",
  );
  if (contributor && !hasFree) {
    list.unshift({
      ...contributor,
      modelId: "muse-spark-1.3-free",
      displayName: "Muse Spark 1.3 Free",
    });
  }
  return list;
}
