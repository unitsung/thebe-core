import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "../../app/config/env.ts";
import { bootstrapThebe } from "../../app/bootstrap.ts";
import {
  productionTokenError,
  resolveThebeListen,
} from "./bind.ts";
import { drainThebeHttpServer } from "./drain.ts";
import { listenThebeHttp } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal(here);

const listen = resolveThebeListen(process.env);
const tokenError = productionTokenError(listen.token, process.env.NODE_ENV);
if (tokenError) {
  console.error(tokenError);
  process.exit(1);
}

const { handler: app, version, agent } = await bootstrapThebe({
  fromDir: here,
  allowedHosts: listen.allowedHosts,
});

const { server, url, bind } = await listenThebeHttp(app, {
  host: listen.host,
  port: listen.port,
});
console.log(`THEBE_LISTEN ${url} (${version}) bind=${bind}`);
console.log(`THEBE_DOCS ${url}/docs`);

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
    .finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
