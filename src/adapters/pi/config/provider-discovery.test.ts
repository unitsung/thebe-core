import { describe, expect, it, vi } from "vitest";
import { discoverProviderModels } from "./provider-discovery.ts";
import type { RuntimeProviderConfiguration } from "../../../agent/runtime/interface.ts";

const configuration: RuntimeProviderConfiguration = {
  providerId: "custom", baseUrl: "https://service.test/proxy/v1/", api: "openai-completions",
  models: [{ id: "catalog-only" }, { id: "real", reasoning: true }],
};
describe("service model discovery", () => {
  it("uses the configured path and key, excludes catalogue-only IDs and deduplicates", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "real" }, { id: "new" }, { id: "real" }] }));
    expect(await discoverProviderModels(configuration, { apiKey: "fixture" }, request)).toEqual([
      { id: "real", name: "real", reasoning: true }, { id: "new", name: "new" },
    ]);
    expect(request.mock.calls[0]?.[0]).toBe("https://service.test/proxy/v1/models");
    expect(request.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer fixture");
    expect(request.mock.calls[0]?.[1].redirect).toBe("error");
  });
  it("does not retry an authentication failure or expose its response", async () => {
    const request = vi.fn().mockResolvedValue(new Response("secret fixture", { status: 401 }));
    await expect(discoverProviderModels(configuration, {}, request)).rejects.toThrow("HTTP 401");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("falls back within the same prefix for a missing endpoint", async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ models: ["models/remote"] }));
    expect(await discoverProviderModels({ ...configuration, baseUrl: "https://service.test/proxy" }, {}, request))
      .toEqual([{ id: "remote", name: "remote" }]);
    expect(request.mock.calls.map(call => call[0])).toEqual([
      "https://service.test/proxy/models", "https://service.test/proxy/v1/models",
    ]);
  });
  it("preserves an authoritative empty list and rejects malformed data", async () => {
    expect(await discoverProviderModels(configuration, {}, vi.fn().mockResolvedValue(Response.json({ data: [] })))).toEqual([]);
    await expect(discoverProviderModels(configuration, {}, vi.fn().mockResolvedValue(Response.json({ error: "oops" })))).rejects.toThrow("invalid model list");
  });
  it("uses the ClinePass subscription feed without mixing in usage-billed models", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({
      clinePass: [{ id: "cline-pass/new" }], free: [{ id: "cline-free/free" }], recommended: [{ id: "paid/model" }],
    }));
    const models = await discoverProviderModels({ ...configuration, baseUrl: "https://api.cline.bot/api/v1", models: [{ id: "cline-pass/old" }] }, {}, request);
    expect(models.map(model => model.id)).toEqual(["cline-pass/new", "cline-free/free"]);
    expect(request.mock.calls[0]?.[0]).toBe("https://api.cline.bot/api/v1/ai/cline/recommended-models");
  });
});

describe("limits in a discovered list", () => {
  it("takes the sizes the service reports and keeps earlier ones where it reports none", async () => {
    const saved: RuntimeProviderConfiguration = {
      ...configuration,
      models: [{ id: "kept", contextWindow: 64000, maxTokens: 4096 }, { id: "updated", contextWindow: 8000 }],
    };
    const request = vi.fn().mockResolvedValue(Response.json({ data: [
      { id: "kept" },
      { id: "updated", context_length: 200000, max_completion_tokens: 16000 },
      { id: "fresh", context_window: 32768 },
      { id: "bare" },
    ] }));
    const models = await discoverProviderModels(saved, {}, request);
    const byId = Object.fromEntries(models.map(model => [model.id, model]));
    expect(byId.kept).toMatchObject({ contextWindow: 64000, maxTokens: 4096 });
    expect(byId.updated).toMatchObject({ contextWindow: 200000, maxTokens: 16000 });
    expect(byId.fresh).toMatchObject({ contextWindow: 32768 });
    expect(byId.bare?.contextWindow).toBeUndefined();
    expect(byId.bare?.maxTokens).toBeUndefined();
  });
});
