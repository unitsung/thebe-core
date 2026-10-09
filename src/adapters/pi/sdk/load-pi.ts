import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function piDistDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
    );
    if (existsSync(join(candidate, "core", "sdk.js"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("Could not find @earendil-works/pi-coding-agent dist");
}

export function piDistUrl(rel: string): string {
  return pathToFileURL(join(piDistDir(), rel)).href;
}

/**
 * pi-ai ships inside the Pi agent's own dependency tree (Core pins it as a dev
 * dependency only), so its dist is resolved the same way as the agent's: walk up
 * from Core's location and, when the install is pruned (pnpm production), from
 * the real path of the agent package so pnpm's sibling link is found.
 */
export function findPiAiDist(roots: string[]): string | undefined {
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 12; i++) {
      const candidate = join(
        dir,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
      );
      if (existsSync(join(candidate, "index.js"))) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

export function piAiDistDir(): string {
  const roots = [dirname(fileURLToPath(import.meta.url))];
  try {
    roots.push(realpathSync(piDistDir()));
  } catch {}
  const found = findPiAiDist(roots);
  if (!found) {
    throw new Error("Could not find @earendil-works/pi-ai dist");
  }
  return found;
}

export function piAiDistUrl(rel: string): string {
  return pathToFileURL(join(piAiDistDir(), rel)).href;
}

export async function loadPiSdk() {
  const sdk = await import(piDistUrl("core/sdk.js"));
  const session = await import(piDistUrl("core/session-manager.js"));
  const settings = await import(piDistUrl("core/settings-manager.js"));
  const modelRuntime = await import(piDistUrl("core/model-runtime.js"));
  const extensions = await import(piDistUrl("core/extensions/index.js"));
  const source = await import(piDistUrl("core/source-info.js"));
  const eventBus = await import(piDistUrl("core/event-bus.js"));
  const bash = await import(piDistUrl("core/tools/bash.js"));
  const skills = await import(piDistUrl("core/skills.js"));
  const mcp = await import(piDistUrl("extensions/mcp/index.js"));
  const mcpRuntime = await import(piDistUrl("extensions/mcp/runtime.js"));
  const mcpServers = await import(piDistUrl("core/mcp-servers.js"));
  const codemode = await import(piDistUrl("extensions/codemode/index.js"));
  const toolSearch = await import(piDistUrl("extensions/tool-search/index.js"));
  return {
    createToolSearchExtension: toolSearch.createToolSearchExtension as typeof toolSearch.createToolSearchExtension,
    createDefaultMcpTransport: mcpRuntime.createDefaultTransport as typeof mcpRuntime.createDefaultTransport,
    createMcpExtension: mcp.createMcpExtension as typeof mcp.createMcpExtension,
    createCodemodeExtension: codemode.createCodemodeExtension as typeof codemode.createCodemodeExtension,
    isMcpToolName: mcpServers.isMcpToolName as typeof mcpServers.isMcpToolName,
    mcpNamespace: mcpServers.mcpNamespace as typeof mcpServers.mcpNamespace,
    loadSkills: skills.loadSkills as typeof skills.loadSkills,
    loadSkillsFromDir: skills.loadSkillsFromDir as typeof skills.loadSkillsFromDir,
    createAgentSession: sdk.createAgentSession as typeof sdk.createAgentSession,
    createBashTool: bash.createBashTool as typeof bash.createBashTool,
    createLocalBashOperations:
      bash.createLocalBashOperations as typeof bash.createLocalBashOperations,
    defineTool: extensions.defineTool as typeof extensions.defineTool,
    createExtensionRuntime:
      extensions.createExtensionRuntime as typeof extensions.createExtensionRuntime,
    loadExtensionFromFactory:
      extensions.loadExtensionFromFactory as typeof extensions.loadExtensionFromFactory,
    createEventBus: eventBus.createEventBus as typeof eventBus.createEventBus,
    SessionManager: session.SessionManager as typeof session.SessionManager,
    SettingsManager: settings.SettingsManager as typeof settings.SettingsManager,
    ModelRuntime: modelRuntime.ModelRuntime as typeof modelRuntime.ModelRuntime,
    createSyntheticSourceInfo:
      source.createSyntheticSourceInfo as typeof source.createSyntheticSourceInfo,
  };
}

export type PiSdk = Awaited<ReturnType<typeof loadPiSdk>>;
