import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { ArcaneAdapter, createThebeAgent } from "../dist/index.js";

function loadEnvLocal() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

const baseUrl = process.env.ARCANE_BASE_URL;
const arcaneKey = process.env.ARCANE_API_KEY;
const openCodeKey = process.env.OPENCODE_API_KEY;
if (!baseUrl || !arcaneKey || !openCodeKey) {
  console.log("LIVE_ASK=skipped missing env");
  process.exit(0);
}

const models = createModels();
models.setProvider(opencodeProvider());
const model = models.getModel("opencode", "muse-spark-1.3-contributor-free");
if (!model) {
  throw new Error("muse-spark-1.3-contributor-free not in OpenCode catalog");
}

const thebe = createThebeAgent({
  models,
  model,
  streamFn: models.streamSimple.bind(models),
  provider: new ArcaneAdapter({ baseUrl, apiKey: arcaneKey }),
});

const reply = await thebe.ask(
  "How many containers are running? Call container.status_summary, then answer with the running count.",
);
const toolNames = thebe
  .messages()
  .filter((m) => m.role === "toolResult")
  .map((m) => m.toolName);
console.log("LIVE_ASK_TOOLS", toolNames.join(",") || "(none)");
console.log("LIVE_ASK_REPLY", reply.replace(/\s+/g, " ").slice(0, 500));
