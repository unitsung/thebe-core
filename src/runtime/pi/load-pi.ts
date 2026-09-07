import { existsSync } from "node:fs";
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

export async function loadPiSdk() {
  const sdk = await import(piDistUrl("core/sdk.js"));
  const session = await import(piDistUrl("core/session-manager.js"));
  const settings = await import(piDistUrl("core/settings-manager.js"));
  const modelRuntime = await import(piDistUrl("core/model-runtime.js"));
  const extensions = await import(piDistUrl("core/extensions/index.js"));
  const source = await import(piDistUrl("core/source-info.js"));
  return {
    createAgentSession: sdk.createAgentSession as typeof sdk.createAgentSession,
    defineTool: extensions.defineTool as typeof extensions.defineTool,
    createExtensionRuntime:
      extensions.createExtensionRuntime as typeof extensions.createExtensionRuntime,
    SessionManager: session.SessionManager as typeof session.SessionManager,
    SettingsManager: settings.SettingsManager as typeof settings.SettingsManager,
    ModelRuntime: modelRuntime.ModelRuntime as typeof modelRuntime.ModelRuntime,
    createSyntheticSourceInfo:
      source.createSyntheticSourceInfo as typeof source.createSyntheticSourceInfo,
  };
}

export type PiSdk = Awaited<ReturnType<typeof loadPiSdk>>;
