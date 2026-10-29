import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../../../atomic-write.ts";
import { loadThebeUserConfig } from "./user-config.ts";

/** Merge user/env base URLs into agentDir/models.json. */
export function syncAgentModelsFile(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = `${agentDir}/models.json`;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(modelsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    // A corrupt models.json holds every provider definition; writing the
    // merged result over it would erase them. Leave the file for the owner.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Refusing to overwrite ${modelsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  const providers = (data.providers ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  try {
    const userConfig = loadThebeUserConfig();
    if (userConfig.providers) {
      for (const [pId, pCfg] of Object.entries(userConfig.providers)) {
        if (pCfg?.baseUrl) {
          providers[pId] = { ...providers[pId], baseUrl: pCfg.baseUrl };
        }
      }
    }
  } catch {}
  if (process.env.OPENAI_BASE_URL) {
    providers["openai"] = {
      ...providers["openai"],
      baseUrl: process.env.OPENAI_BASE_URL,
    };
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    providers["anthropic"] = {
      ...providers["anthropic"],
      baseUrl: process.env.ANTHROPIC_BASE_URL,
    };
  }
  data.providers = providers;
  writeFileAtomicSync(modelsPath, JSON.stringify(data, null, 2), "utf8");
}
