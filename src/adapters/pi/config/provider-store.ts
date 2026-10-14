import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeProviderConfiguration } from "../../../agent/runtime/interface.ts";
import { removeLegacyProviderOverride } from "./user-config.ts";

/** Serialized, atomic updates preserve unrelated Pi configuration and never return credentials. */
export function createProviderConfigurationStore(agentDir: string, legacyConfigPath?: string) {
  const path = join(agentDir, "models.json");
  let pending: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Record<string, any>> {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }
  function mutate(providerId: string, change: (data: Record<string, any>) => void) {
    const operation = pending.then(async () => {
      const data = await read();
      change(data);
      if (legacyConfigPath) removeLegacyProviderOverride(legacyConfigPath, providerId);
      await mkdir(agentDir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    async get(providerId: string): Promise<RuntimeProviderConfiguration | undefined> {
      await pending;
      const p = (await read()).providers?.[providerId];
      if (!p?.baseUrl || !p.api || !Array.isArray(p.models)) return undefined;
      return { providerId, name: p.name, baseUrl: p.baseUrl, api: p.api,
        models: p.models.map((m: any) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning, input: m.input })) };
    },
    save(configuration: RuntimeProviderConfiguration) {
      return mutate(configuration.providerId, data => {
        const { providerId, ...configurationFields } = configuration;
        data.providers ??= {};
        const previous = data.providers[providerId];
        const models = configuration.models.map(model => {
          const retained = previous?.models?.find((item: any) => item.id === model.id);
          const merged = { ...retained, ...model };
          return merged;
        });
        data.providers[providerId] = { ...previous, ...configurationFields, models };
      });
    },
    delete(providerId: string) {
      return mutate(providerId, data => { if (data.providers) delete data.providers[providerId]; });
    },
  };
}
