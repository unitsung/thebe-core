import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../atomic-write.ts";

export const DEFAULT_THEBE_HOST = "127.0.0.1";
export const DEFAULT_THEBE_PORT = 8787;

export type ThebeListenConfig = {
  host: string;
  port: number;
  token?: string;
  allowedHosts?: string[];
};

/**
 * Resolve HTTP bind settings after `.env.local` has been loaded.
 * Host allowlist is always on (loopback plus bind host). Wildcard binds
 * (`0.0.0.0` / `::`) still require `THEBE_ALLOWED_HOSTS` for LAN Host
 * headers; otherwise DNS-rebinding Origin==Host of an attacker host
 * would pass.
 */
export function resolveThebeListen(
  env: NodeJS.ProcessEnv = process.env
): ThebeListenConfig {
  const host = env.THEBE_HOST?.trim() || DEFAULT_THEBE_HOST;
  const parsedPort = Number(env.THEBE_PORT ?? String(DEFAULT_THEBE_PORT));
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0
      ? parsedPort
      : DEFAULT_THEBE_PORT;
  const token = env.THEBE_TOKEN?.trim() || undefined;
  const extra = (env.THEBE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    host,
    port,
    token,
    allowedHosts: resolveAllowedHosts(host, extra),
  };
}

export const DEFAULT_MCP_RATE_LIMIT_PER_MINUTE = 120;

export type ThebeMcpListenConfig = {
  host: string;
  port: number;
  /** Requests one token may make per minute on this port. */
  ratePerMinute: number;
};

/**
 * The optional second port that serves only `/mcp`. Off unless `THEBE_MCP_PORT` is set. It binds
 * the same host as the main port unless `THEBE_MCP_HOST` says otherwise; `THEBE_MCP_RATE_LIMIT`
 * is requests per minute for each token. A bad value throws instead of falling back, because a
 * silently ignored setting would leave the operator believing the port is up.
 */
export function resolveThebeMcpListen(
  env: NodeJS.ProcessEnv = process.env,
  main: Pick<ThebeListenConfig, "host" | "port"> = resolveThebeListen(env)
): ThebeMcpListenConfig | undefined {
  const rawPort = env.THEBE_MCP_PORT?.trim();
  if (!rawPort) return undefined;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`THEBE_MCP_PORT must be a port number, got "${rawPort}"`);
  }
  if (port === main.port) {
    throw new Error(
      `THEBE_MCP_PORT (${port}) must differ from THEBE_PORT: the /mcp-only port exists so the main API stays off it`
    );
  }
  const rawRate = env.THEBE_MCP_RATE_LIMIT?.trim();
  const ratePerMinute = rawRate
    ? Number(rawRate)
    : DEFAULT_MCP_RATE_LIMIT_PER_MINUTE;
  if (!Number.isInteger(ratePerMinute) || ratePerMinute < 1) {
    throw new Error(
      `THEBE_MCP_RATE_LIMIT must be a whole number of requests per minute, got "${rawRate}"`
    );
  }
  return {
    host: env.THEBE_MCP_HOST?.trim() || main.host,
    port,
    ratePerMinute,
  };
}

export function resolveAllowedHosts(
  bindHost: string,
  extra: string[] = []
): string[] {
  const extras = extra.map((value) => value.trim()).filter(Boolean);
  const wildcard = bindHost === "0.0.0.0" || bindHost === "::";
  const hosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!wildcard && bindHost) {
    hosts.add(bindHost);
  }
  for (const host of extras) {
    hosts.add(host);
  }
  return [...hosts];
}

export function productionTokenError(
  token: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): string | undefined {
  if (nodeEnv === "production" && !token?.trim()) {
    return "THEBE_TOKEN is required in production. Set it in .env.local or environment.";
  }
  return undefined;
}

export type ThebeTokenResolution = {
  token: string;
  /** True when this run created the token (it must be shown to the operator). */
  generated: boolean;
  /** Where the token is persisted, so it survives a restart. */
  path?: string;
};

/**
 * Resolve the shared token without making the operator invent one.
 *
 * Explicit `THEBE_TOKEN` wins. Otherwise the persisted `{configDir}/token` is
 * reused, and only when neither exists is a new 32-byte token generated and
 * written (`0600`). Clients (the app, curl) send it as `X-Thebe-Token`; showing
 * it once on first start is the whole setup step.
 */
export function resolveThebeToken(
  options: {
    env?: NodeJS.ProcessEnv;
    configDir?: string;
    generate?: () => string;
  } = {}
): ThebeTokenResolution {
  const env = options.env ?? process.env;
  const explicit = env.THEBE_TOKEN?.trim();
  if (explicit) {
    return { token: explicit, generated: false };
  }
  const generate = options.generate ?? (() => randomBytes(32).toString("hex"));
  if (options.configDir) {
    const path = join(options.configDir, "token");
    try {
      if (existsSync(path)) {
        const existing = readFileSync(path, "utf8").trim();
        if (existing) return { token: existing, generated: false, path };
      }
    } catch {
      // fall through to generate
    }
    const token = generate();
    try {
      mkdirSync(options.configDir, { recursive: true });
      writeFileAtomicSync(path, `${token}\n`, { mode: 0o600 });
    } catch {
      // The token still works for this run even if it could not be persisted.
    }
    return { token, generated: true, path };
  }
  return { token: generate(), generated: true };
}
