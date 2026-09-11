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
  env: NodeJS.ProcessEnv = process.env,
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

export function resolveAllowedHosts(
  bindHost: string,
  extra: string[] = [],
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
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | undefined {
  if (nodeEnv === "production" && !token?.trim()) {
    return "THEBE_TOKEN is required in production. Set it in .env.local or environment.";
  }
  return undefined;
}
