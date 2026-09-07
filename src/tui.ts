import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { ArcaneAdapter } from "./adapters/arcane-adapter.ts";
import { resolveThebeAuth } from "./auth/credentials.ts";
import { createThebeAgent } from "./ask/index.ts";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";
import { startThebeTui } from "./tui/app.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal(here);

const baseUrl = process.env.ARCANE_BASE_URL;
const arcaneKey = process.env.ARCANE_API_KEY;
const openCodeKey = process.env.OPENCODE_API_KEY;
if (!baseUrl || !arcaneKey || !openCodeKey) {
  console.error(
    "Missing ARCANE_BASE_URL, ARCANE_API_KEY, or OPENCODE_API_KEY",
  );
  console.error(
    "Put them in .env.local (package root or next to dist/tui.js). Looked in:",
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

const auth = await resolveThebeAuth(models, model);
if (!auth) {
  throw new Error("No credentials for the configured model provider");
}

const thebe = createThebeAgent({
  models,
  model,
  streamFn: models.streamSimple.bind(models),
  provider: new ArcaneAdapter({ baseUrl, apiKey: arcaneKey }),
});

startThebeTui({ ask: (text) => thebe.ask(text) });
