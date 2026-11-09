import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ClientMetadata } from "oidc-provider";
import { OAUTH_SUPPORTED_SCOPES } from "./metadata.ts";

export const DEFAULT_OAUTH_CLIENTS_FILE = "oauth-clients.json";
export const DEFAULT_OAUTH_PAIRING_TTL_SECONDS = 300;

export type OAuthConfig = {
  issuer: string;
  resource: string;
  clients: ClientMetadata[];
  clientNames: ReadonlyMap<string, string>;
  dynamicRegistration: boolean;
  registrationInitialAccessToken?: string;
  pairingTtlSeconds: number;
  clientsSource?: string;
};

export function oauthPublicHosts(config: OAuthConfig): string[] {
  return [new URL(config.issuer).host, new URL(config.resource).host];
}

export function resolveOAuthConfig(options: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
}): OAuthConfig | undefined {
  const env = options.env ?? process.env;
  const rawIssuer = env.THEBE_OAUTH_ISSUER?.trim();
  if (!rawIssuer) return undefined;

  const issuer = normalizePublicUrl(rawIssuer, "THEBE_OAUTH_ISSUER");
  if (new URL(issuer).pathname !== "/") {
    throw new Error("THEBE_OAUTH_ISSUER must not include a path");
  }
  const configuredResource = env.THEBE_MCP_RESOURCE_URL?.trim();
  const resource = normalizePublicUrl(
    configuredResource || new URL("/mcp", issuer).toString(),
    "THEBE_MCP_RESOURCE_URL"
  );
  if (new URL(resource).pathname.replace(/\/$/, "") !== "/mcp") {
    throw new Error("THEBE_MCP_RESOURCE_URL must point at /mcp");
  }

  const dynamicRegistration = oauthBoolean(
    env.THEBE_OAUTH_DYNAMIC_REGISTRATION
  );
  const clientsSource = oauthClientsSource(options.configDir, env);
  const rawClients = clientsSource ? readClientsSource(clientsSource) : [];
  const clients = parseOAuthClients(rawClients);
  if (clients.length === 0 && !dynamicRegistration) {
    throw new Error(
      `OAuth needs a pre-registered client in ${join(
        options.configDir,
        DEFAULT_OAUTH_CLIENTS_FILE
      )}, THEBE_OAUTH_CLIENTS, or THEBE_OAUTH_DYNAMIC_REGISTRATION=true`
    );
  }

  const initialAccessToken =
    env.THEBE_OAUTH_REGISTRATION_TOKEN?.trim() || undefined;
  return {
    issuer,
    resource,
    clients,
    clientNames: new Map(
      clients.map((client) => [
        String(client.client_id),
        String(client.client_name ?? client.client_id),
      ])
    ),
    dynamicRegistration,
    ...(initialAccessToken
      ? { registrationInitialAccessToken: initialAccessToken }
      : {}),
    pairingTtlSeconds: positiveInteger(
      env.THEBE_OAUTH_PAIRING_TTL_SECONDS,
      DEFAULT_OAUTH_PAIRING_TTL_SECONDS,
      60,
      900
    ),
    ...(clientsSource ? { clientsSource } : {}),
  };
}

export function parseOAuthClients(value: unknown): ClientMetadata[] {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as { clients?: unknown }).clients
      : undefined;
  if (!Array.isArray(values)) {
    throw new Error("OAuth clients must be a JSON array or {clients:[...]}");
  }

  const clients: ClientMetadata[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of values.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`OAuth client ${index} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const clientId = firstString(record.clientId, record.client_id);
    const clientName =
      firstString(record.clientName, record.client_name) ?? clientId;
    const clientSecret = firstString(record.clientSecret, record.client_secret);
    const redirectUris = stringList(
      record.redirectUris ?? record.redirect_uris,
      `OAuth client ${clientId ?? index} redirectUris`
    );
    if (!clientId || clientId.length > 100) {
      throw new Error(
        `OAuth client ${index} needs a clientId of at most 100 characters`
      );
    }
    if (ids.has(clientId)) {
      throw new Error(`OAuth client id ${clientId} is repeated`);
    }
    ids.add(clientId);
    if (!clientName || clientName.length > 120) {
      throw new Error(
        `OAuth client ${clientId} needs a clientName of at most 120 characters`
      );
    }
    if (redirectUris.length === 0) {
      throw new Error(
        `OAuth client ${clientId} needs at least one redirect URI`
      );
    }
    for (const redirectUri of redirectUris) {
      validateRedirectUri(redirectUri, clientId);
    }

    const scopeValue = record.scope ?? record.scopes;
    const scopes =
      scopeValue === undefined
        ? ["mcp:read", "offline_access"]
        : typeof scopeValue === "string"
          ? scopeValue.split(/\s+/).filter(Boolean)
          : stringList(scopeValue, `OAuth client ${clientId} scopes`);
    const uniqueScopes = [...new Set(scopes)];
    for (const scope of uniqueScopes) {
      if (!(OAUTH_SUPPORTED_SCOPES as readonly string[]).includes(scope)) {
        throw new Error(`OAuth client ${clientId} has unknown scope ${scope}`);
      }
    }
    if (!uniqueScopes.some((scope) => scope.startsWith("mcp:"))) {
      throw new Error(`OAuth client ${clientId} needs at least one mcp scope`);
    }

    clients.push({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      token_endpoint_auth_method: clientSecret ? "client_secret_basic" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: uniqueScopes.join(" "),
    });
  }
  return clients;
}

function oauthClientsSource(
  configDir: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const inline = env.THEBE_OAUTH_CLIENTS?.trim();
  if (inline) return inline;
  const configured = env.THEBE_OAUTH_CLIENTS_FILE?.trim();
  const path = configured
    ? isAbsolute(configured)
      ? resolve(configured)
      : resolve(configDir, configured)
    : join(configDir, DEFAULT_OAUTH_CLIENTS_FILE);
  if (configured && !existsSync(path)) {
    throw new Error(`THEBE_OAUTH_CLIENTS_FILE does not exist: ${path}`);
  }
  return existsSync(path) ? path : undefined;
}

function readClientsSource(source: string): unknown {
  const text =
    source.trim().startsWith("{") || source.trim().startsWith("[")
      ? source
      : readFileSync(source, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `OAuth clients are not valid JSON: ${source.startsWith("/") ? source : "THEBE_OAUTH_CLIENTS"}`
    );
  }
}

function normalizePublicUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${name} must not contain credentials, a query, or a fragment`
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error(`${name} must use HTTPS outside localhost`);
  }
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
}

function validateRedirectUri(value: string, clientId: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OAuth client ${clientId} has an invalid redirect URI`);
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname)))
  ) {
    throw new Error(
      `OAuth client ${clientId} redirect URIs must use HTTPS except on localhost`
    );
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function oauthBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}
