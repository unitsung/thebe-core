import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "../config/env.ts";
import { bootstrapThebe } from "../product/bootstrap.ts";
import {
  productionTokenError,
  resolveThebeListen,
} from "./bind.ts";
import { listenThebeHttp } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvLocal(here);

const listen = resolveThebeListen(process.env);
const tokenError = productionTokenError(listen.token, process.env.NODE_ENV);
if (tokenError) {
  console.error(tokenError);
  process.exit(1);
}

const { handler: app, version } = await bootstrapThebe({
  fromDir: here,
  allowedHosts: listen.allowedHosts,
});

const { url, bind } = await listenThebeHttp(app, {
  host: listen.host,
  port: listen.port,
});
console.log(`THEBE_LISTEN ${url} (${version}) bind=${bind}`);
