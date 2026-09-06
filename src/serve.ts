import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { ArcaneAdapter } from "./adapters/arcane-adapter.ts";
import { createThebeAgent } from "./ask/index.ts";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";
import { createThebeHttpHandler, listenThebeHttp } from "./http/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal(here);

const version = readPackageVersion();
const baseUrl = process.env.ARCANE_BASE_URL;
const arcaneKey = process.env.ARCANE_API_KEY;
const openCodeKey = process.env.OPENCODE_API_KEY;
if (!baseUrl || !arcaneKey || !openCodeKey) {
  console.error(
    "Missing ARCANE_BASE_URL, ARCANE_API_KEY, or OPENCODE_API_KEY",
  );
  console.error(
    "Put them in .env.local (package root or next to dist/serve.js). Looked in:",
  );
  for (const path of envLocalCandidates(here)) {
    console.error(`  ${path}`);
  }
  process.exit(1);
}

const models = createModels();
models.setProvider(opencodeProvider());
const model = models.getModel("opencode", "muse-spark-1.3-contributor-free");
if (!model) {
  throw new Error("muse-spark-1.3-contributor-free not in OpenCode catalog");
}

const provider = new ArcaneAdapter({ baseUrl, apiKey: arcaneKey });
const thebe = createThebeAgent({
  model,
  streamFn: models.streamSimple.bind(models),
  provider,
  getApiKey: () => openCodeKey,
});

const port = Number(process.env.THEBE_PORT ?? "8787");
const host = process.env.THEBE_HOST ?? "0.0.0.0";
const app = createThebeHttpHandler({
  version,
  provider,
  token: process.env.THEBE_TOKEN,
  ask: async (text) => {
    const reply = await thebe.ask(text);
    const tools = thebe
      .messages()
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolName);
    return { text: reply, tools };
  },
});

const { url } = await listenThebeHttp(app, { host, port });
console.log(`THEBE_LISTEN ${url}`);

function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { version?: string };
      if (parsed.version) {
        return parsed.version;
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "0.1.0";
}
