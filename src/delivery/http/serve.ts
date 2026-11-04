import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "../../app/config/env.ts";
import { bootstrapThebe } from "../../app/bootstrap.ts";
import { buildIsolationReport } from "../../agent/security/isolation.ts";
import { resolveThebeListen, resolveThebeMcpListen } from "./bind.ts";
import { drainThebeHttpServer } from "./drain.ts";
import { listenThebeHttp } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal(here);

const listen = resolveThebeListen(process.env);
let mcpListen: ReturnType<typeof resolveThebeMcpListen>;
try {
  mcpListen = resolveThebeMcpListen(process.env, listen);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const {
  handler: app,
  createMcpHandler,
  version,
  agent,
  token,
  tokenGenerated,
  tokenPath,
  workspacePath,
  disposeSandboxVms,
} = await bootstrapThebe({
  fromDir: here,
  allowedHosts: listen.allowedHosts,
});

const isolation = buildIsolationReport({ workspacePath });
for (const warning of isolation.warnings) {
  console.warn(`SECURITY: ${warning}`);
}
if (isolation.sandbox.reason) {
  console.warn(`SECURITY: ${isolation.sandbox.reason}`);
}

const { server, url, bind } = await listenThebeHttp(app, {
  host: listen.host,
  port: listen.port,
});
console.log(`THEBE_LISTEN ${url} (${version}) bind=${bind}`);
console.log(`THEBE_DOCS ${url}/docs`);
// The second port serves only /mcp, so it is the one to expose to the internet.
const mcpServer = mcpListen
  ? await listenThebeHttp(
      createMcpHandler({
        rateLimit: { limit: mcpListen.ratePerMinute, windowMs: 60_000 },
      }),
      { host: mcpListen.host, port: mcpListen.port }
    )
  : undefined;
if (mcpServer && mcpListen) {
  console.log(
    `THEBE_MCP_LISTEN ${mcpServer.url}/mcp (only /mcp; ${mcpListen.ratePerMinute} requests/min per token) bind=${mcpServer.bind}`
  );
}
if (tokenGenerated) {
  console.log(`THEBE_TOKEN ${token}`);
  if (tokenPath) {
    console.log(`THEBE_TOKEN_FILE ${tokenPath}`);
  }
  console.log(
    "New token generated; paste it into the app. It is saved and reused on restart."
  );
}

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.error(`received ${signal}; draining`);
  const force = setTimeout(() => process.exit(1), 8_000);
  force.unref?.();
  const quiesced = agent.quiesce();
  void Promise.all([
    drainThebeHttpServer(server, () => quiesced),
    mcpServer
      ? drainThebeHttpServer(mcpServer.server, () => quiesced)
      : undefined,
  ])
    .catch(() => {})
    .finally(async () => {
      // Requests have drained. Close the OS-sandbox proxies so they do not
      // outlive Core.
      await disposeSandboxVms().catch(() => {});
      clearTimeout(force);
      process.exit(0);
    });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
