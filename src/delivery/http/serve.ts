import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "../../app/config/env.ts";
import { bootstrapThebe } from "../../app/bootstrap.ts";
import { buildIsolationReport } from "../../agent/security/isolation.ts";
import { resolveThebeListen } from "./bind.ts";
import { drainThebeHttpServer } from "./drain.ts";
import { listenThebeHttp } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal(here);

const listen = resolveThebeListen(process.env);

const {
  handler: app,
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
  void drainThebeHttpServer(server, () => agent.quiesce())
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
