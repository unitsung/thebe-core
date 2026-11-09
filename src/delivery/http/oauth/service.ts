import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, {
  errors,
  type Configuration,
  type Interaction,
  type InteractionResults,
} from "oidc-provider";
import { jwtVerify } from "jose";
import type { OAuthConfig } from "./config.ts";
import { createOAuthAdapter } from "./adapter.ts";
import { loadOrCreateOAuthKeys, type OAuthKeyMaterial } from "./keys.ts";
import {
  MCP_OAUTH_SCOPES,
  OAUTH_SUPPORTED_SCOPES,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
} from "./metadata.ts";
import { PairingCodeStore, type IssuedPairingCode } from "./pairing.ts";
import { renderAuthorizationPage, renderOAuthMessage } from "./page.ts";
import { createRateLimiter } from "../rate-limit.ts";
import { requestHostAllowed, validateRequestSecurity } from "../security.ts";
import type { TokenCaller, TokenScope } from "../token-store.ts";
import { json } from "../json.ts";

const OWNER_ACCOUNT_ID = "thebe-owner";
const PAIRING_ACR = "urn:thebe:oauth:pairing";
const CSRF_COOKIE = "thebe_oauth_csrf";
const CSRF_TTL_SECONDS = 15 * 60;
const MAX_FORM_BYTES = 16 * 1024;
const INTERACTION_BASE = "/oauth/interaction/";
const TOKEN_PATH = "/oauth/token";

const PROVIDER_PATHS = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
]);

type AccessTokenPayload = {
  jti?: unknown;
  client_id?: unknown;
  client_name?: unknown;
  scope?: unknown;
};

export type OAuthHttpIntegration = {
  verify(received: string): Promise<TokenCaller | undefined>;
  isPublicPath(path: string): boolean;
  publicResponse(request: Request): Response | undefined;
  issuePairingCode(): IssuedPairingCode;
  resource: string;
};

export type ThebeOAuthService = OAuthHttpIntegration & {
  readonly issuer: string;
  readonly provider: Provider;
  handleNode(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

export async function createThebeOAuth(options: {
  configDir: string;
  config: OAuthConfig;
  allowedHosts?: readonly string[];
  now?: () => number;
  generatePairingCode?: () => string;
}): Promise<ThebeOAuthService> {
  const now = options.now ?? Date.now;
  const keys = await loadOrCreateOAuthKeys({
    configDir: options.configDir,
    issuer: options.config.issuer,
  });
  const pairing = new PairingCodeStore(options.configDir, {
    ttlSeconds: options.config.pairingTtlSeconds,
    now,
    generate: options.generatePairingCode,
  });
  const allowedHosts = options.allowedHosts
    ? new Set(options.allowedHosts)
    : undefined;
  const provider = new Provider(
    options.config.issuer,
    providerConfiguration({
      config: options.config,
      configDir: options.configDir,
      keys,
      now,
    })
  );
  const callback = provider.callback();
  const tokenLimiter = createRateLimiter({
    limit: 120,
    windowMs: 60_000,
    now,
  });
  const pairingLimiter = createRateLimiter({
    limit: 5,
    windowMs: 10 * 60_000,
    now,
  });
  const pairingIpLimiter = createRateLimiter({
    limit: 20,
    windowMs: 10 * 60_000,
    now,
  });
  const metadataPaths = new Set([
    "/.well-known/oauth-protected-resource",
    protectedResourceMetadataPath(options.config.resource),
  ]);

  const service: ThebeOAuthService = {
    issuer: options.config.issuer,
    resource: options.config.resource,
    provider,
    isPublicPath(path) {
      return metadataPaths.has(path);
    },
    publicResponse(request) {
      const path = new URL(request.url).pathname.replace(/\/$/, "") || "/";
      if (!metadataPaths.has(path)) return undefined;
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          {
            ok: false,
            error: "Protected resource metadata is read-only",
            code: "method_not_allowed",
          },
          405,
          { allow: "GET, HEAD" }
        );
      }
      return new Response(
        JSON.stringify({
          ...protectedResourceMetadata({
            issuer: options.config.issuer,
            resource: options.config.resource,
          }),
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
            "x-content-type-options": "nosniff",
          },
        }
      );
    },
    issuePairingCode() {
      return pairing.issue();
    },
    async verify(received) {
      return verifyAccessToken(received, {
        provider,
        keys,
        config: options.config,
      });
    },
    async handleNode(req, res) {
      const path = requestPath(req);
      if (!isProviderPath(path) && !path.startsWith(INTERACTION_BASE)) {
        return false;
      }
      if (!validateNodeSecurity(req, path, allowedHosts)) {
        sendJson(res, 403, { ok: false, error: "request host not allowed" });
        return true;
      }
      const remote = req.socket.remoteAddress ?? "unknown";
      if (req.method === "POST" && path === TOKEN_PATH) {
        const wait = tokenLimiter.take(remote);
        if (wait !== undefined) {
          sendJson(
            res,
            429,
            { ok: false, error: "too many token requests" },
            { "retry-after": String(wait) }
          );
          return true;
        }
      }
      if (path.startsWith(INTERACTION_BASE)) {
        await handleInteractionRequest(req, res, {
          provider,
          config: options.config,
          keys,
          pairing,
          now,
          remote,
          pairingLimiter,
          pairingIpLimiter,
        });
        return true;
      }
      await callback(req, res);
      return true;
    },
  };
  return service;
}

function providerConfiguration(options: {
  config: OAuthConfig;
  configDir: string;
  keys: OAuthKeyMaterial;
  now: () => number;
}): Configuration {
  const { config, keys } = options;
  const secureCookie = new URL(config.issuer).protocol === "https:";
  return {
    adapter: createOAuthAdapter(options.configDir),
    clients: config.clients,
    clientDefaults: {
      id_token_signed_response_alg: "PS256",
    },
    jwks: keys.jwks,
    cookies: {
      keys: keys.cookieKeys,
      names: {
        session: "thebe_oidc_session",
        interaction: "thebe_oidc_interaction",
        resume: "thebe_oidc_resume",
      },
      long: {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie,
      },
      short: {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookie,
      },
    },
    scopes: OAUTH_SUPPORTED_SCOPES,
    claims: { sub: null },
    responseTypes: ["code"],
    subjectTypes: ["public"],
    acrValues: [PAIRING_ACR],
    pkce: {
      required: () => true,
    },
    interactions: {
      url: (_ctx, interaction) =>
        `${INTERACTION_BASE}${encodeURIComponent(interaction.uid)}`,
    },
    findAccount(_ctx, sub) {
      if (sub !== OWNER_ACCOUNT_ID) return undefined;
      return {
        accountId: OWNER_ACCOUNT_ID,
        claims: async () => ({ sub: OWNER_ACCOUNT_ID }),
      };
    },
    features: {
      devInteractions: { enabled: false },
      registration: {
        enabled: config.dynamicRegistration,
        ...(config.registrationInitialAccessToken
          ? { initialAccessToken: config.registrationInitialAccessToken }
          : {}),
      },
      registrationManagement: {
        enabled: config.dynamicRegistration,
        rotateRegistrationAccessToken: true,
      },
      revocation: {
        enabled: true,
        allowedPolicy(_ctx, client, token) {
          return token.clientId === client.clientId;
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => config.resource,
        useGrantedResource: () => true,
        getResourceServerInfo(_ctx, indicator) {
          if (indicator !== config.resource) {
            throw new errors.InvalidTarget();
          }
          return {
            scope: MCP_OAUTH_SCOPES.join(" "),
            audience: config.resource,
            accessTokenFormat: "jwt",
            accessTokenTTL: 15 * 60,
            jwt: { sign: { alg: "PS256" } },
          };
        },
      },
      userinfo: { enabled: false },
      introspection: { enabled: false },
      deviceFlow: { enabled: false },
      ciba: { enabled: false },
      clientCredentials: { enabled: false },
      rpInitiatedLogout: { enabled: false },
    },
    routes: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      revocation: "/oauth/revoke",
      jwks: "/oauth/jwks",
      registration: "/oauth/register",
    },
    ttl: {
      AccessToken: 15 * 60,
      AuthorizationCode: 60,
      RefreshToken: 30 * 24 * 60 * 60,
      Grant: 30 * 24 * 60 * 60,
      Interaction: 15 * 60,
      Session: 30 * 24 * 60 * 60,
    },
    rotateRefreshToken: true,
    revokeGrantPolicy: () => true,
    async extraTokenClaims(_ctx, token) {
      const clientId = token.clientId;
      if (token.kind === "AccessToken") {
        const issuedAt = token.iat ?? Math.floor(options.now() / 1000);
        const expiresAt = token.exp ?? issuedAt + token.expiration;
        await token.adapter.upsert(
          token.jti,
          {
            jti: token.jti,
            kind: token.kind,
            iat: issuedAt,
            exp: expiresAt,
            clientId,
            accountId: token.accountId,
            grantId: token.grantId,
            scope: token.scope,
            aud: token.aud,
            gty: token.gty,
            sessionUid: token.sessionUid,
            sid: token.sid,
            expiresWithSession: token.expiresWithSession,
          },
          Math.max(1, expiresAt - issuedAt)
        );
      }
      return {
        client_name:
          (clientId && config.clientNames.get(clientId)) ??
          token.client?.clientName ??
          clientId,
      };
    },
    discovery: {
      resource_indicators_supported: true,
      scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
    },
    renderError(ctx, _out, error) {
      const status =
        "status" in error && typeof error.status === "number"
          ? error.status
          : 400;
      ctx.status = status;
      ctx.type = "html";
      ctx.set("cache-control", "no-store");
      ctx.set("content-security-policy", htmlSecurityPolicy());
      ctx.body = renderOAuthMessage(
        "Authorization could not continue",
        "The request is invalid or has expired. Return to the client and try again.",
        `${status}`
      );
    },
    clientBasedCORS: () => false,
  };
}

async function handleInteractionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    provider: Provider;
    config: OAuthConfig;
    keys: OAuthKeyMaterial;
    pairing: PairingCodeStore;
    now: () => number;
    remote: string;
    pairingLimiter: ReturnType<typeof createRateLimiter>;
    pairingIpLimiter: ReturnType<typeof createRateLimiter>;
  }
): Promise<void> {
  const uid = interactionUid(req);
  if (!uid) {
    sendHtml(
      res,
      404,
      renderOAuthMessage("Authorization not found", "This link is invalid.")
    );
    return;
  }
  let details: Interaction;
  try {
    details = await options.provider.interactionDetails(req, res);
  } catch {
    sendHtml(
      res,
      404,
      renderOAuthMessage(
        "Authorization not found",
        "This authorization request has expired. Return to the client and try again."
      )
    );
    return;
  }
  const clientId = stringValue(details.params.client_id) ?? "Unknown client";
  const client = await options.provider.Client.find(clientId);
  const clientName = client?.clientName ?? clientId;
  const requestedScopes = interactionScopes(details);

  if (req.method === "GET") {
    const csrf = createCsrf(uid, options.keys.csrfSecret, options.now());
    setCsrfCookie(res, uid, csrf, options.config.issuer);
    sendHtml(
      res,
      200,
      renderAuthorizationPage({
        uid,
        csrf,
        clientName,
        scopes: requestedScopes,
        requireCode: interactionNeedsLogin(details),
      })
    );
    return;
  }
  if (req.method !== "POST") {
    sendJson(
      res,
      405,
      { ok: false, error: "method not allowed" },
      { allow: "GET, POST" }
    );
    return;
  }

  const wait =
    options.pairingLimiter.take(`${options.remote}:${uid}`) ??
    options.pairingIpLimiter.take(options.remote);
  if (wait !== undefined) {
    sendHtml(
      res,
      429,
      renderOAuthMessage(
        "Too many attempts",
        `Wait ${wait} seconds before trying the pairing code again.`,
        "429 Too Many Requests"
      ),
      { "retry-after": String(wait) }
    );
    return;
  }

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch (error) {
    sendHtml(
      res,
      413,
      renderOAuthMessage(
        "Request too large",
        error instanceof Error ? error.message : "The form could not be read."
      )
    );
    return;
  }
  const csrf = form.get("csrf") ?? "";
  const cookieCsrf = cookieValue(req.headers.cookie, CSRF_COOKIE) ?? "";
  if (
    !csrf ||
    !sameValue(csrf, cookieCsrf) ||
    !validCsrf(csrf, uid, options.keys.csrfSecret, options.now())
  ) {
    sendHtml(
      res,
      403,
      renderOAuthMessage(
        "Authorization expired",
        "Reload the authorization request and try again.",
        "403 Forbidden"
      )
    );
    return;
  }

  if (form.get("decision") !== "approve") {
    await options.provider.interactionFinished(req, res, {
      error: "access_denied",
      error_description: "The homeowner denied this request.",
    });
    return;
  }

  const selected = selectedScopes(form, requestedScopes);
  const needsLogin = interactionNeedsLogin(details);
  if (needsLogin && !options.pairing.consume(form.get("code") ?? "")) {
    setCsrfCookie(res, uid, csrf, options.config.issuer);
    sendHtml(
      res,
      401,
      renderAuthorizationPage({
        uid,
        csrf,
        clientName,
        scopes: requestedScopes,
        selectedScopes: selected,
        requireCode: true,
        error: "The pairing code is invalid or has expired.",
      })
    );
    return;
  }
  if (!selected.some((scope) => scope.startsWith("mcp:"))) {
    setCsrfCookie(res, uid, csrf, options.config.issuer);
    sendHtml(
      res,
      400,
      renderAuthorizationPage({
        uid,
        csrf,
        clientName,
        scopes: requestedScopes,
        selectedScopes: selected,
        requireCode: false,
        error: "Select at least one MCP permission.",
      })
    );
    return;
  }

  const grant = new options.provider.Grant({
    accountId: OWNER_ACCOUNT_ID,
    clientId,
  });
  const mcpScopes = selected.filter((scope) =>
    (MCP_OAUTH_SCOPES as readonly string[]).includes(scope)
  );
  const rejected = requestedScopes.filter((scope) => !selected.includes(scope));
  const rejectedMcp = rejected.filter((scope) =>
    (MCP_OAUTH_SCOPES as readonly string[]).includes(scope)
  );
  grant.addOIDCScope(requestedScopes);
  grant.addResourceScope(options.config.resource, mcpScopes);
  if (rejected.length > 0) grant.rejectOIDCScope(rejected);
  if (rejectedMcp.length > 0) {
    grant.rejectResourceScope(options.config.resource, rejectedMcp);
  }
  const grantId = await grant.save();
  const result: InteractionResults = {
    ...(needsLogin
      ? {
          login: {
            accountId: OWNER_ACCOUNT_ID,
            acr: PAIRING_ACR,
            amr: ["pairing_code"],
            remember: false,
            ts: Math.floor(options.now() / 1000),
          },
        }
      : {}),
    consent: { grantId },
  };
  await options.provider.interactionFinished(req, res, result);
}

async function verifyAccessToken(
  received: string,
  options: {
    provider: Provider;
    keys: OAuthKeyMaterial;
    config: OAuthConfig;
  }
): Promise<TokenCaller | undefined> {
  if (!received || !received.includes(".")) return undefined;
  try {
    const { payload } = await jwtVerify<AccessTokenPayload>(
      received,
      options.keys.verificationKeys,
      {
        issuer: options.config.issuer,
        audience: options.config.resource,
        typ: "at+jwt",
        clockTolerance: 5,
      }
    );
    const jti = stringValue(payload.jti);
    const clientId = stringValue(payload.client_id);
    const scope = stringValue(payload.scope);
    if (!jti || !clientId || !scope) return undefined;
    const token = await options.provider.AccessToken.find(jti);
    if (!token || token.clientId !== clientId || token.scope !== scope) {
      return undefined;
    }
    const scopeList = [...new Set(scope.split(/\s+/).filter(Boolean))];
    if (
      scopeList.some(
        (entry) =>
          !(OAUTH_SUPPORTED_SCOPES as readonly string[]).includes(entry)
      )
    ) {
      return undefined;
    }
    const scopes = MCP_OAUTH_SCOPES.filter((entry) =>
      scopeList.includes(entry)
    ) as TokenScope[];
    if (scopes.length === 0) return undefined;
    const claimedName = stringValue(payload.client_name);
    return {
      name: claimedName ?? options.config.clientNames.get(clientId) ?? clientId,
      scopes,
    };
  } catch {
    return undefined;
  }
}

function validateNodeSecurity(
  req: IncomingMessage,
  path: string,
  allowedHosts: Set<string> | undefined
): boolean {
  const host = req.headers.host;
  if (allowedHosts && allowedHosts.size > 0) {
    if (!host || !requestHostAllowed(host, allowedHosts)) return false;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const request = new Request(`http://${host ?? "localhost"}${path}`, {
    method: req.method ?? "GET",
    headers,
  });
  return validateRequestSecurity(request, allowedHosts).ok;
}

function requestPath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.pathname.replace(/\/$/, "") || "/";
}

function isProviderPath(path: string): boolean {
  return PROVIDER_PATHS.has(path) || path.startsWith("/oauth/");
}

function interactionUid(req: IncomingMessage): string | undefined {
  const path = requestPath(req);
  if (!path.startsWith(INTERACTION_BASE)) return undefined;
  const encoded = path.slice(INTERACTION_BASE.length);
  if (!encoded || encoded.includes("/")) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function interactionNeedsLogin(details: Interaction): boolean {
  return details.prompt.name === "login" || !details.session?.accountId;
}

function interactionScopes(details: Interaction): string[] {
  const raw = stringValue(details.params.scope) ?? "mcp:read";
  const requested = [...new Set(raw.split(/\s+/).filter(Boolean))];
  const allowed = requested.filter((scope) =>
    (OAUTH_SUPPORTED_SCOPES as readonly string[]).includes(scope)
  );
  return allowed.length > 0 ? allowed : ["mcp:read"];
}

function selectedScopes(
  form: URLSearchParams,
  requested: readonly string[]
): string[] {
  const selected = new Set(form.getAll("scope"));
  return requested.filter((scope) => selected.has(scope));
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) {
      throw new Error("The authorization form is too large.");
    }
    chunks.push(buffer);
  }
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("The authorization form has an unsupported content type.");
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function createCsrf(uid: string, secret: Buffer, now: number): string {
  const expires = Math.floor(now / 1000) + CSRF_TTL_SECONDS;
  const payload = `${uid}.${expires}.${randomBytes(18).toString("base64url")}`;
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function validCsrf(
  token: string,
  uid: string,
  secret: Buffer,
  now: number
): boolean {
  const [tokenUid, expiresRaw, nonce, signature] = token.split(".");
  const expires = Number(expiresRaw);
  if (
    tokenUid !== uid ||
    !nonce ||
    !signature ||
    !Number.isSafeInteger(expires) ||
    expires < Math.floor(now / 1000)
  ) {
    return false;
  }
  const payload = `${tokenUid}.${expiresRaw}.${nonce}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return sameValue(signature, expected);
}

function setCsrfCookie(
  res: ServerResponse,
  uid: string,
  value: string,
  issuer: string
): void {
  const secure = new URL(issuer).protocol === "https:" ? "; Secure" : "";
  res.setHeader(
    "set-cookie",
    `${CSRF_COOKIE}=${encodeURIComponent(
      value
    )}; Path=${INTERACTION_BASE}${uid}; Max-Age=${CSRF_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`
  );
}

function cookieValue(
  header: string | undefined,
  name: string
): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sameValue(left: string, right: string): boolean {
  const leftDigest = Buffer.from(left);
  const rightDigest = Buffer.from(right);
  return (
    leftDigest.length === rightDigest.length &&
    timingSafeEqual(leftDigest, rightDigest)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sendHtml(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": htmlSecurityPolicy(),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    ...headers,
  });
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function htmlSecurityPolicy(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
}
