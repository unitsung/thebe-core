import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ArcaneAdapter } from "./adapters/arcane-adapter.ts";
import { applyThebeApiKey } from "./auth/credentials.ts";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";
import { createThebeApp } from "./product/app.ts";
import { createPiCodingAgentRuntime } from "./runtime/pi/pi-coding-agent-runtime.ts";
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

const runtime = await createPiCodingAgentRuntime({
  cwd: process.cwd(),
  sessionDir: process.env.THEBE_SESSION_DIR,
  agentDir: process.env.THEBE_AGENT_DIR,
  apiKey: { providerId: "opencode", key: openCodeKey },
});
await applyThebeApiKey(runtime.auth(), "opencode", openCodeKey);

const { send } = createThebeApp({
  runtime,
  provider: new ArcaneAdapter({ baseUrl, apiKey: arcaneKey }),
});

startThebeTui({
  send: async (text) => {
    const result = await send(text);
    return result.text;
  },
});
