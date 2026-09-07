import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";

export function wrapModelsForHarness(
  models: Models,
  streamFn: StreamFn,
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined,
): Models {
  return {
    getProviders: () => models.getProviders(),
    getProvider: (id) => models.getProvider(id),
    getModels: (provider) => models.getModels(provider),
    getModel: (provider, id) => models.getModel(provider, id),
    refresh: (options) => models.refresh(options),
    checkAuth: (providerId, options) => models.checkAuth(providerId, options),
    getAvailable: (providerId, options) =>
      models.getAvailable(providerId, options),
    getAuth: (async (
      providerOrModel: string | Model<string>,
      overrides?: Parameters<Models["getAuth"]>[1],
    ) => {
      const resolved =
        typeof providerOrModel === "string"
          ? await models.getAuth(providerOrModel, overrides)
          : await models.getAuth(providerOrModel, overrides);
      if (resolved || !getApiKey) {
        return resolved;
      }
      const provider =
        typeof providerOrModel === "string"
          ? providerOrModel
          : providerOrModel.provider;
      const key = await getApiKey(provider);
      if (!key) {
        return resolved;
      }
      return { auth: { apiKey: key }, source: "getApiKey" };
    }) as Models["getAuth"],
    login: (providerId, type, interaction) =>
      models.login(providerId, type, interaction),
    logout: (providerId, options) => models.logout(providerId, options),
    stream: (model, aiContext, options) =>
      models.stream(model, aiContext, options),
    complete: (model, aiContext, options) =>
      models.complete(model, aiContext, options),
    streamSimple: (model, aiContext, options) => {
      const stream = streamFn(model, aiContext, options);
      if (stream instanceof Promise) {
        throw new TypeError("streamFn must return a stream, not a Promise");
      }
      return stream;
    },
    completeSimple: (model, aiContext, options) =>
      models.completeSimple(model, aiContext, options),
    streamDeferred: (model, handle, options) =>
      models.streamDeferred(model, handle, options),
    fetchDeferred: (model, handle, options) =>
      models.fetchDeferred(model, handle, options),
    cancelDeferred: (model, handle, options) =>
      models.cancelDeferred(model, handle, options),
  };
}
