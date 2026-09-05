import { createModels } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { ArcaneAdapter, createThebeAgent } from "../dist/index.js";

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
  model,
  streamFn: models.streamSimple.bind(models),
  provider: new ArcaneAdapter({ baseUrl, apiKey: arcaneKey }),
  getApiKey: () => openCodeKey,
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
