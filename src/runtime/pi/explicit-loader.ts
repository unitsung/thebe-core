import type { EnabledResource } from "../types.ts";
import type { PiSdk } from "./load-pi.ts";

type ResourceLoader = {
  getExtensions: () => unknown;
  getSkills: () => unknown;
  getPrompts: () => unknown;
  getThemes: () => unknown;
  getAgentsFiles: () => unknown;
  getSystemPrompt: () => string | undefined;
  getSystemPromptSource: () => unknown;
  getAppendSystemPrompt: () => string[];
  getAppendSystemPromptSources: () => unknown[];
  extendResources: () => void;
  reload: () => Promise<void>;
};

export function createExplicitResourceLoader(options: {
  systemPrompt: string;
  enabledResources?: EnabledResource[];
  sdk: PiSdk;
  extensions?: unknown[];
  extensionRuntime?: unknown;
}): ResourceLoader {
  const skills = (options.enabledResources ?? [])
    .filter((resource) => resource.kind === "skill")
    .map((resource) => ({
      name: resource.identity,
      description: resource.identity,
      filePath: resource.source,
      baseDir: resource.source,
      sourceInfo: options.sdk.createSyntheticSourceInfo(resource.source, {
        source: resource.source,
        scope: "temporary",
        origin: "top-level",
        baseDir: resource.source,
      }),
      disableModelInvocation: false,
    }));

  return {
    getExtensions: () => ({
      extensions: options.extensions ?? [],
      errors: [],
      runtime:
        options.extensionRuntime ?? options.sdk.createExtensionRuntime(),
    }),
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
