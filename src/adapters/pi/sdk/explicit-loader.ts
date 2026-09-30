import type { EnabledResource } from "../../../agent/runtime/interface.ts";
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
  reloadExtensions?: () => Promise<{ extensions: unknown[]; runtime: unknown }>;
}): ResourceLoader {
  const loadEnabledSkills = () => options.sdk.loadSkills({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    includeDefaults: false,
    skillPaths: (options.enabledResources ?? [])
      .filter((resource) => resource.kind === "skill")
      .map((resource) => resource.source),
  });

  let skills = loadEnabledSkills();
  let extensions = options.extensions ?? [];
  let runtime = options.extensionRuntime ?? options.sdk.createExtensionRuntime();

  return {
    getExtensions: () => ({
      extensions,
      errors: [],
      runtime,
    }),
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {
      skills = loadEnabledSkills();
      if (options.reloadExtensions) {
        const loaded = await options.reloadExtensions();
        extensions = loaded.extensions;
        runtime = loaded.runtime;
      }
    },
  };
}
