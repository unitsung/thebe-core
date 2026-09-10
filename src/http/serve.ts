import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "../product/bootstrap.ts";
import { listenThebeHttp } from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { handler: app, version } = await bootstrapThebe({ fromDir: here });

const port = Number(process.env.THEBE_PORT ?? "8787");
const host = process.env.THEBE_HOST ?? "0.0.0.0";

const { url } = await listenThebeHttp(app, { host, port });
console.log(`THEBE_LISTEN ${url} (${version})`);
