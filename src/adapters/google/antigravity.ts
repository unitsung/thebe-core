import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  OAuthAuthorizeResult,
  RuntimeAuth,
  RuntimeModel,
  RuntimeProvider,
} from "../../agent/runtime/interface.ts";

/**
 * Google Cloud Code Assist (Antigravity / Gemini CLI) provider for Thebe Core.
 *
 * Core owns this provider because Pi removed its built-in Antigravity entry in
 * 0.71: the OAuth flow, credential store, project discovery, model list, and
 * Pi provider registration live here and are exposed through the existing
 * `/v1/provider` + `/v1/provider/{id}/oauth/*` routes. `antigravity-provider.ts`
 * registers the Pi-side provider so sessions can chat with it.
 */

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
export const ANTIGRAVITY_DISPLAY_NAME = "Antigravity";

export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";
export const CODE_ASSIST_CLIENT_HEADER =
  "google-cloud-sdk vscode_cloudshelleditor/0.1";
export const AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const USERINFO_ENDPOINT =
  "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
export const LOOPBACK_REDIRECT_URI = "http://localhost:51121/oauth-callback";

export type AntigravityClientKind = "antigravity" | "gemini-cli";

type ClientConfig = {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  userAgent: string;
};

/**
 * OAuth client ids for the Cloud Code Assist backends. The client secret is not
 * bundled: supply it through `THEBE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET` or
 * `THEBE_GOOGLE_GEMINI_CLI_CLIENT_SECRET`. Without one, sign-in and refresh fail
 * with a clear error.
 */
export const ANTIGRAVITY_CLIENTS: Record<AntigravityClientKind, ClientConfig> = {
  antigravity: {
    clientId:
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    get clientSecret() {
      return process.env.THEBE_GOOGLE_ANTIGRAVITY_CLIENT_SECRET ?? "";
    },
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    userAgent: "antigravity/1.15.8 thebe-core",
  },
  "gemini-cli": {
    clientId:
      "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    get clientSecret() {
      return process.env.THEBE_GOOGLE_GEMINI_CLI_CLIENT_SECRET ?? "";
    },
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    userAgent: "gemini-cli/0.1.0 thebe-core",
  },
};

function requireClientSecret(client: ClientConfig, kind: AntigravityClientKind): void {
  if (client.clientSecret) return;
  const name = kind === "antigravity" ? "ANTIGRAVITY" : "GEMINI_CLI";
  throw new Error(`Google OAuth client secret is not configured (set THEBE_GOOGLE_${name}_CLIENT_SECRET)`);
}

export const CLIENT_METADATA = JSON.stringify({
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
});

export type AntigravityCredential = {
  kind: AntigravityClientKind;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  projectId?: string;
  account?: string;
  tokenType?: string;
};

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

// MARK: - PKCE + authorization URL

function base64Url(data: Buffer): string {
  return data
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizationUrl(options: {
  kind: AntigravityClientKind;
  state: string;
  challenge: string;
  redirectUri?: string;
}): string {
  const client = ANTIGRAVITY_CLIENTS[options.kind];
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri ?? LOOPBACK_REDIRECT_URI);
  url.searchParams.set("scope", client.scopes.join(" "));
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/** Accepts a bare authorization code or the full pasted redirect URL. */
export function parseAuthorizationCode(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("://")) {
    try {
      const code = new URL(trimmed).searchParams.get("code");
      return code && code.length > 0 ? code : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.includes(" ")) return undefined;
  return trimmed;
}

// MARK: - Token exchange + refresh

function formBody(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields).sort()) {
    params.set(key, value);
  }
  return params.toString();
}

function credentialFromTokenResponse(
  payload: Record<string, unknown>,
  kind: AntigravityClientKind,
  previousRefreshToken?: string,
  now = Date.now(),
): AntigravityCredential | undefined {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return undefined;
  }
  const expiresIn = Number(payload.expires_in);
  const refreshToken = payload.refresh_token;
  return {
    kind,
    accessToken,
    refreshToken:
      typeof refreshToken === "string" && refreshToken.length > 0
        ? refreshToken
        : previousRefreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
  };
}

export async function tokenError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    const description = payload.error_description;
    if (typeof description === "string" && description.length > 0) return description;
    const error = payload.error;
    if (typeof error === "string" && error.length > 0) return error;
  } catch {}
  return `HTTP ${response.status}`;
}

export async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  options: {
    kind: AntigravityClientKind;
    code: string;
    verifier: string;
    redirectUri?: string;
  },
): Promise<AntigravityCredential> {
  const client = ANTIGRAVITY_CLIENTS[options.kind];
  requireClientSecret(client, options.kind);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri ?? LOOPBACK_REDIRECT_URI,
      code_verifier: options.verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(await tokenError(response));
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const credential = credentialFromTokenResponse(payload, options.kind);
  if (!credential) throw new Error("token response has no access_token");
  return credential;
}

export async function refreshCredential(
  fetchImpl: FetchLike,
  credential: AntigravityCredential,
): Promise<AntigravityCredential> {
  const refreshToken = credential.refreshToken;
  if (!refreshToken) throw new Error("no refresh token stored");
  const client = ANTIGRAVITY_CLIENTS[credential.kind];
  requireClientSecret(client, credential.kind);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    throw new Error(await tokenError(response));
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const refreshed = credentialFromTokenResponse(
    payload,
    credential.kind,
    refreshToken,
  );
  if (!refreshed) throw new Error("refresh response has no access_token");
  return {
    ...credential,
    ...refreshed,
    projectId: credential.projectId,
    account: credential.account,
  };
}

export function credentialNeedsRefresh(
  credential: AntigravityCredential,
  now = Date.now(),
): boolean {
  if (credential.expiresAt === undefined) return false;
  return credential.expiresAt - now < 60_000;
}

// MARK: - Cloud Code Assist

export function methodUrl(
  method: string,
  endpoint = CODE_ASSIST_ENDPOINT,
): string {
  return `${endpoint.replace(/\/+$/, "")}/${CODE_ASSIST_API_VERSION}:${method}`;
}

/** Long-running operations live under `/v1internal/{name}` as plain GETs. */
export function operationUrl(
  operation: string,
  endpoint = CODE_ASSIST_ENDPOINT,
): string {
  const name = operation.replace(/^operations\//, "");
  return `${endpoint.replace(/\/+$/, "")}/${CODE_ASSIST_API_VERSION}/${name}`;
}

export async function codeAssistOperationRequest(
  fetchImpl: FetchLike,
  operation: string,
  credential: AntigravityCredential,
  endpoint = CODE_ASSIST_ENDPOINT,
): Promise<Response> {
  return fetchImpl(operationUrl(operation, endpoint), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      "User-Agent": ANTIGRAVITY_CLIENTS[credential.kind].userAgent,
      "X-Goog-Api-Client": CODE_ASSIST_CLIENT_HEADER,
      "Client-Metadata": CLIENT_METADATA,
    },
  });
}

export async function codeAssistRequest(
  fetchImpl: FetchLike,
  method: string,
  body: Record<string, unknown>,
  credential: AntigravityCredential,
  endpoint = CODE_ASSIST_ENDPOINT,
): Promise<Response> {
  return fetchImpl(methodUrl(method, endpoint), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credential.accessToken}`,
      "User-Agent": ANTIGRAVITY_CLIENTS[credential.kind].userAgent,
      "X-Goog-Api-Client": CODE_ASSIST_CLIENT_HEADER,
      "Client-Metadata": CLIENT_METADATA,
    },
    body: JSON.stringify(body),
  });
}

export function loadCodeAssistBody(): Record<string, unknown> {
  return { metadata: JSON.parse(CLIENT_METADATA) as Record<string, unknown> };
}

export function onboardUserBody(tierId: string): Record<string, unknown> {
  return {
    tierId,
    metadata: JSON.parse(CLIENT_METADATA) as Record<string, unknown>,
  };
}

export function projectFromLoadResponse(
  payload: Record<string, unknown>,
): string | undefined {
  const project = payload.cloudaicompanionProject;
  if (typeof project === "string" && project.length > 0) return project;
  if (project && typeof project === "object") {
    const id = (project as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

export function defaultTierFromLoadResponse(
  payload: Record<string, unknown>,
): string | undefined {
  const tiers = payload.allowedTiers;
  if (!Array.isArray(tiers)) return undefined;
  const rows = tiers.filter(
    (tier): tier is Record<string, unknown> => !!tier && typeof tier === "object",
  );
  const preferred = rows.find((tier) => tier.isDefault === true);
  const id =
    preferred?.id ??
    rows.map((tier) => tier.id).find((value) => typeof value === "string");
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function projectFromOperation(
  payload: Record<string, unknown>,
): string | undefined {
  if (payload.done !== true) return undefined;
  const response = payload.response;
  if (!response || typeof response !== "object") return undefined;
  return projectFromLoadResponse(response as Record<string, unknown>);
}

/** `loadCodeAssist` → project; onboards the default tier when the account has none. */
export async function resolveProjectId(
  fetchImpl: FetchLike,
  credential: AntigravityCredential,
  endpoint = CODE_ASSIST_ENDPOINT,
): Promise<string | undefined> {
  const loadResponse = await codeAssistRequest(
    fetchImpl,
    "loadCodeAssist",
    loadCodeAssistBody(),
    credential,
    endpoint,
  );
  if (!loadResponse.ok) return undefined;
  const loadPayload = (await loadResponse.json()) as Record<string, unknown>;
  const existing = projectFromLoadResponse(loadPayload);
  if (existing) return existing;

  const tier = defaultTierFromLoadResponse(loadPayload) ?? "free-tier";
  const onboardResponse = await codeAssistRequest(
    fetchImpl,
    "onboardUser",
    onboardUserBody(tier),
    credential,
    endpoint,
  );
  if (!onboardResponse.ok) return undefined;
  const onboardPayload = (await onboardResponse.json()) as Record<string, unknown>;
  const onboarded = projectFromOperation(onboardPayload);
  if (onboarded) return onboarded;

  const name = onboardPayload.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const operation = name.replace(/^operations\//, "");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const poll = await codeAssistOperationRequest(
      fetchImpl,
      operation,
      credential,
      endpoint,
    );
    if (!poll.ok) return undefined;
    const payload = (await poll.json()) as Record<string, unknown>;
    const project = projectFromOperation(payload);
    if (project) return project;
    if (payload.done === true) return undefined;
  }
  return undefined;
}

export type AntigravityModel = { id: string; displayName?: string };

/** `fetchAvailableModels` → the models the signed-in account can use. */
export async function fetchAvailableModels(
  fetchImpl: FetchLike,
  credential: AntigravityCredential,
  endpoint = CODE_ASSIST_ENDPOINT,
): Promise<AntigravityModel[]> {
  if (!credential.projectId) return [];
  const response = await codeAssistRequest(
    fetchImpl,
    "fetchAvailableModels",
    { project: credential.projectId },
    credential,
    endpoint,
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as Record<string, unknown>;
  const models = payload.models;
  if (!models || typeof models !== "object") return [];
  return Object.entries(models as Record<string, Record<string, unknown>>)
    .map(([id, info]) => ({
      id,
      displayName: typeof info?.displayName === "string" ? info.displayName : undefined,
    }))
    .filter((model) => model.id.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function generateContentBody(options: {
  projectId: string;
  model: string;
  request: Record<string, unknown>;
  requestId?: string;
}): Record<string, unknown> {
  return {
    project: options.projectId,
    model: options.model,
    request: options.request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId:
      options.requestId ?? `agent-${Date.now()}-${randomBytes(4).toString("hex")}`,
  };
}

export type CloudCodeTextResult = {
  text: string;
  usage?: Record<string, unknown>;
};

function textFromCandidate(payload: Record<string, unknown>): string {
  const inner = (payload.response ?? payload) as Record<string, unknown>;
  const candidates = inner.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const first = candidates[0];
  if (!first || typeof first !== "object") return "";
  const content = (first as Record<string, unknown>).content;
  if (!content || typeof content !== "object") return "";
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
        ? ((part as Record<string, unknown>).text as string)
        : "",
    )
    .join("");
}

export function codeAssistError(payload: Record<string, unknown>): string | undefined {
  const error = payload.error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

/**
 * One text turn against Cloud Code Assist. Core probes use this; Pi sessions use
 * a Pi provider extension, which speaks the same envelope.
 */
export async function generateText(
  fetchImpl: FetchLike,
  credential: AntigravityCredential,
  options: {
    model: string;
    prompt: string;
    maxOutputTokens?: number;
    endpoint?: string;
  },
): Promise<CloudCodeTextResult> {
  const projectId = credential.projectId;
  if (!projectId) throw new Error("no Cloud project resolved");
  const response = await codeAssistRequest(
    fetchImpl,
    "generateContent",
    generateContentBody({
      projectId,
      model: options.model,
      request: {
        contents: [{ role: "user", parts: [{ text: options.prompt }] }],
        generationConfig: { maxOutputTokens: options.maxOutputTokens ?? 512 },
      },
    }),
    credential,
    options.endpoint,
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(codeAssistError(payload) ?? `HTTP ${response.status}`);
  }
  const inner = (payload.response ?? payload) as Record<string, unknown>;
  const usage = inner.usageMetadata;
  return {
    text: textFromCandidate(payload),
    usage: usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined,
  };
}

// MARK: - Credential store

/**
 * Credentials live next to Pi's own `auth.json` (mode 0600) so a backup of the
 * agent directory carries the Google session with it.
 */
export class AntigravityCredentialStore {
  constructor(readonly filePath: string) {}

  private read(): Record<string, AntigravityCredential> {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, AntigravityCredential>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private write(all: Record<string, AntigravityCredential>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(all, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  get(providerId: string): AntigravityCredential | undefined {
    const credential = this.read()[providerId];
    if (!credential || typeof credential.accessToken !== "string") return undefined;
    return credential;
  }

  set(providerId: string, credential: AntigravityCredential): void {
    const all = this.read();
    all[providerId] = credential;
    this.write(all);
  }

  delete(providerId: string): void {
    const all = this.read();
    if (!(providerId in all)) return;
    delete all[providerId];
    this.write(all);
  }
}

// MARK: - Core auth adapter

export type AntigravityAdapterOptions = {
  store: AntigravityCredentialStore;
  fetchImpl?: FetchLike;
  endpoint?: string;
  kind?: AntigravityClientKind;
};

type PendingLogin = {
  kind: AntigravityClientKind;
  verifier: string;
  state: string;
  redirectUri: string;
};

export type AntigravityAuth = {
  readonly providerId: string;
  handles(providerId: string): boolean;
  providers(): RuntimeProvider[];
  authorizeOAuth(providerId: string, options?: { force?: boolean }): Promise<OAuthAuthorizeResult>;
  submitOAuthCallback(providerId: string, input: string): Promise<void>;
  logout(providerId: string): Promise<void>;
  check(providerId: string): Promise<{ ok: boolean }>;
  testProvider(providerId: string): Promise<{ ok: boolean; message?: string }>;
  credential(providerId: string, options?: { forceRefresh?: boolean }): Promise<AntigravityCredential>;
  models(providerId: string): Promise<RuntimeModel[]>;
};

/**
 * Antigravity/Gemini OAuth for Core's `/v1/provider` surface. The flow is
 * start → user signs in → paste the code, matching the headless OAuth contract
 * (`authorizeOAuth` + `submitOAuthCallback`) that the app already speaks.
 */
export function createAntigravityAuth(
  options: AntigravityAdapterOptions,
): AntigravityAuth {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const endpoint = options.endpoint ?? CODE_ASSIST_ENDPOINT;
  const defaultKind = options.kind ?? "antigravity";
  const pending = new Map<string, PendingLogin>();

  function provider(): RuntimeProvider {
    const stored = options.store.get(ANTIGRAVITY_PROVIDER_ID);
    return {
      id: ANTIGRAVITY_PROVIDER_ID,
      displayName: ANTIGRAVITY_DISPLAY_NAME,
      authMethods: ["oauth"],
      authStatus: stored ? "connected" : "missing",
      oauthPending: pending.has(ANTIGRAVITY_PROVIDER_ID),
    };
  }

  async function credential(
    providerId: string,
    refreshOptions?: { forceRefresh?: boolean },
  ): Promise<AntigravityCredential> {
    if (providerId !== ANTIGRAVITY_PROVIDER_ID) {
      throw new Error(`unknown provider: ${providerId}`);
    }
    let stored = options.store.get(providerId);
    if (!stored) throw new Error("Google account is not connected");
    if (stored.refreshToken && (refreshOptions?.forceRefresh || credentialNeedsRefresh(stored))) {
      stored = await refreshCredential(fetchImpl, stored);
      options.store.set(providerId, stored);
    }
    if (!stored.projectId) {
      const projectId = await resolveProjectId(fetchImpl, stored, endpoint);
      if (projectId) {
        stored = { ...stored, projectId };
        options.store.set(providerId, stored);
      }
    }
    return stored;
  }

  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    handles: (providerId) => providerId === ANTIGRAVITY_PROVIDER_ID,
    providers: () => [provider()],

    async authorizeOAuth(providerId) {
      if (providerId !== ANTIGRAVITY_PROVIDER_ID) {
        throw new Error(`unknown provider: ${providerId}`);
      }
      const pkce = generatePkce();
      const kind = defaultKind;
      const redirectUri = LOOPBACK_REDIRECT_URI;
      const state = base64Url(randomBytes(16));
      pending.set(providerId, { kind, verifier: pkce.verifier, state, redirectUri });
      const url = buildAuthorizationUrl({
        kind,
        state,
        challenge: pkce.challenge,
        redirectUri,
      });
      return {
        providerId,
        pending: true,
        url,
        instructions:
          "Sign in with Google, then paste the authorization code (or the full redirected URL) back.",
      };
    },

    async submitOAuthCallback(providerId, input) {
      const login = pending.get(providerId);
      if (!login) throw new Error("no OAuth login is pending for this provider");
      const code = parseAuthorizationCode(input);
      if (!code) throw new Error("authorization code is empty");
      let credential = await exchangeAuthorizationCode(fetchImpl, {
        kind: login.kind,
        code,
        verifier: login.verifier,
        redirectUri: login.redirectUri,
      });
      credential.account = await fetchAccount(fetchImpl, credential);
      const projectId = await resolveProjectId(fetchImpl, credential, endpoint);
      if (projectId) credential = { ...credential, projectId };
      options.store.set(providerId, credential);
      pending.delete(providerId);
    },

    async logout(providerId) {
      pending.delete(providerId);
      options.store.delete(providerId);
    },

    async check(providerId) {
      return { ok: options.store.get(providerId) !== undefined };
    },

    async testProvider(providerId) {
      try {
        const stored = await credential(providerId, { forceRefresh: true });
        const models = await fetchAvailableModels(fetchImpl, stored, endpoint);
        const first = models[0];
        if (!first) {
          return { ok: false, message: "no models available for this account" };
        }
        const result = await generateText(fetchImpl, stored, {
          model: first.id,
          prompt: "ping",
          maxOutputTokens: 16,
          endpoint,
        });
        const suffix = result.text ? `: ${result.text.slice(0, 40)}` : "";
        return { ok: true, message: `probed ${first.id}${suffix}` };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },

    credential,

    async models(providerId) {
      try {
        const stored = await credential(providerId);
        const list = await fetchAvailableModels(fetchImpl, stored, endpoint);
        return list.map((model) => ({
          providerId: ANTIGRAVITY_PROVIDER_ID,
          modelId: model.id,
          displayName: model.displayName,
          supportsThinking: true,
          available: true,
        }));
      } catch {
        return [];
      }
    },
  };
}

async function fetchAccount(
  fetchImpl: FetchLike,
  credential: AntigravityCredential,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${credential.accessToken}` },
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as Record<string, unknown>;
    const email = payload.email;
    return typeof email === "string" && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wrap Pi's auth so Antigravity ids route to the local adapter while every other
 * provider keeps Pi's own behaviour.
 */
export function withAntigravityAuth(
  base: RuntimeAuth,
  antigravity: AntigravityAuth,
): RuntimeAuth {
  return {
    ...base,
    async listProviders() {
      const providers = await base.listProviders();
      // Pi now knows `google-antigravity` too (Core registers a provider on its
      // ModelRuntime), but Core owns the sign-in: its entry carries the OAuth
      // methods and connection status, so it replaces Pi's api-key view.
      const extras = antigravity.providers();
      const merged = providers.map(
        (provider) => extras.find((extra) => extra.id === provider.id) ?? provider,
      );
      for (const extra of extras) {
        if (!merged.some((provider) => provider.id === extra.id)) {
          merged.push(extra);
        }
      }
      return merged;
    },
    async setApiKey(providerId, apiKey) {
      if (antigravity.handles(providerId)) {
        throw new Error(
          `${ANTIGRAVITY_PROVIDER_ID} signs in with Google OAuth instead of an API key`,
        );
      }
      return base.setApiKey(providerId, apiKey);
    },
    async loginOAuth(providerId, interaction) {
      if (!antigravity.handles(providerId)) {
        return base.loginOAuth(providerId, interaction);
      }
      const result = await antigravity.authorizeOAuth(providerId);
      if (result.pending && result.url) {
        await interaction.openUrl?.(result.url);
      }
      throw new Error("finish the Google sign-in by submitting the authorization code");
    },
    async authorizeOAuth(providerId, options) {
      if (!antigravity.handles(providerId)) {
        return base.authorizeOAuth(providerId, options);
      }
      return antigravity.authorizeOAuth(providerId, options);
    },
    async submitOAuthCallback(providerId, input) {
      if (!antigravity.handles(providerId)) {
        return base.submitOAuthCallback(providerId, input);
      }
      return antigravity.submitOAuthCallback(providerId, input);
    },
    async logout(providerId) {
      if (!antigravity.handles(providerId)) {
        return base.logout(providerId);
      }
      return antigravity.logout(providerId);
    },
    async check(providerId) {
      if (!antigravity.handles(providerId)) {
        return base.check(providerId);
      }
      return antigravity.check(providerId);
    },
    async testProvider(providerId) {
      if (!antigravity.handles(providerId)) {
        return base.testProvider(providerId);
      }
      return antigravity.testProvider(providerId);
    },
  };
}
