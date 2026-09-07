import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArcaneAdapter } from "./adapters/arcane-adapter.ts";
import { applyThebeApiKey } from "./auth/credentials.ts";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";
import { listenThebeHttp } from "./http/index.ts";
import { createThebeApp } from "./product/app.ts";
import { createPiCodingAgentRuntime } from "./runtime/pi/pi-coding-agent-runtime.ts";

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

const provider = new ArcaneAdapter({ baseUrl, apiKey: arcaneKey });
const runtime = await createPiCodingAgentRuntime({
  cwd: process.cwd(),
  sessionDir: process.env.THEBE_SESSION_DIR,
  agentDir: process.env.THEBE_AGENT_DIR,
  apiKey: { providerId: "opencode", key: openCodeKey },
});
await applyThebeApiKey(runtime.auth(), "opencode", openCodeKey);

const { handler: app } = createThebeApp({
  runtime,
  provider,
  version,
  token: process.env.THEBE_TOKEN,
});

const port = Number(process.env.THEBE_PORT ?? "8787");
const host = process.env.THEBE_HOST ?? "0.0.0.0";

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
