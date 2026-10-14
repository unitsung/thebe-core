import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProviderConfigurationStore } from "./provider-store.ts";
import type { RuntimeProviderConfiguration } from "../../../agent/runtime/interface.ts";

const configuration: RuntimeProviderConfiguration = {
  providerId: "custom", baseUrl: "https://example.test/v1", api: "openai-completions",
  models: [{ id: "first" }, { id: "second" }],
};
describe("provider configuration storage", () => {
  it("removes stale startup overrides on edit and deletion while preserving other settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ autoCompact: false, providers: {
      custom: { baseUrl: "https://obsolete.test" }, other: { baseUrl: "https://other.test" },
    } }));
    const store = createProviderConfigurationStore(dir, path);
    await store.save(configuration);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ autoCompact: false, providers: { other: { baseUrl: "https://other.test" } } });
    await writeFile(path, JSON.stringify({ providers: { custom: { baseUrl: "https://obsolete.test" } } }));
    await store.delete("custom");
    expect(JSON.parse(await readFile(path, "utf8")).providers).toEqual({});
    expect(await store.get("custom")).toBeUndefined();
  });
  it("edits and removes models, preserves unrelated providers, and omits all credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-config-"));
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {
      custom: { ...configuration, apiKey: "private", headers: { Authorization: "private" } },
      other: { baseUrl: "https://other.test", apiKey: "untouched" },
    } }));
    const store = createProviderConfigurationStore(dir);
    expect(JSON.stringify(await store.get("custom"))).not.toContain("private");
    await store.save({ ...configuration, models: [{ id: "renamed" }] });
    const reloaded = createProviderConfigurationStore(dir);
    expect((await reloaded.get("custom"))?.models).toEqual([{ id: "renamed" }]);
    await reloaded.delete("custom");
    expect(await reloaded.get("custom")).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "models.json"), "utf8")).providers.other.apiKey).toBe("untouched");
  });
  it("serializes concurrent mutations without losing another provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-config-"));
    const store = createProviderConfigurationStore(dir);
    await Promise.all([store.save(configuration), store.save({ ...configuration, providerId: "other" })]);
    expect(await store.get("custom")).toBeDefined();
    expect(await store.get("other")).toBeDefined();
  });
  it("does not overwrite corrupt existing configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-config-"));
    await writeFile(join(dir, "models.json"), "broken");
    await expect(createProviderConfigurationStore(dir).save(configuration)).rejects.toThrow();
    expect(await readFile(join(dir, "models.json"), "utf8")).toBe("broken");
  });
  it("preserves model compatibility and leaves the thinking-level map to the model entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-config-"));
    const model = { id: "cline-pass/deepseek-v4.1-flash", reasoning: true, input: ["text"], compat: { supportsDeveloperRole: false } };
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { cline: { models: [model] } } }));
    await createProviderConfigurationStore(dir).save({ ...configuration, providerId: "cline", baseUrl: "https://api.cline.bot/api/v1", models: [{ id: model.id, reasoning: true, input: ["text", "image"] }] });
    const stored = JSON.parse(await readFile(join(dir, "models.json"), "utf8")).providers.cline.models[0];
    expect(stored.compat.supportsDeveloperRole).toBe(false);
    expect(stored.thinkingLevelMap).toBeUndefined();
    expect(stored.input).toEqual(["text", "image"]);
  });
  it("stores the levels a model offers, returns them, and keeps them through a discovery refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "provider-config-"));
    const store = createProviderConfigurationStore(dir);
    const thinkingLevelMap = { minimal: null, xhigh: "xhigh" };
    await store.save({ ...configuration, models: [{ id: "first", reasoning: true, thinkingLevelMap }] });
    expect((await store.get("custom"))?.models[0]?.thinkingLevelMap).toEqual(thinkingLevelMap);
    // Discovery saves the listed models without a map; the user's choice must survive it.
    await store.save({ ...configuration, models: [{ id: "first", contextWindow: 8000 }] });
    const refreshed = (await store.get("custom"))?.models[0];
    expect(refreshed?.thinkingLevelMap).toEqual(thinkingLevelMap);
    expect(refreshed?.contextWindow).toBe(8000);
    // An explicit save from the editor replaces it, including with no restriction.
    await store.save({ ...configuration, models: [{ id: "first", thinkingLevelMap: undefined }] });
    expect((await store.get("custom"))?.models[0]?.thinkingLevelMap).toBeUndefined();
  });
});
