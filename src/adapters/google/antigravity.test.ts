import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  OAuthAuthorizeResult,
  RuntimeAuth,
} from "../../agent/runtime/interface.ts";
import {
  ANTIGRAVITY_PROVIDER_ID,
  AntigravityCredentialStore,
  buildAuthorizationUrl,
  createAntigravityAuth,
  credentialNeedsRefresh,
  defaultTierFromLoadResponse,
  exchangeAuthorizationCode,
  fetchAvailableModels,
  generatePkce,
  methodUrl,
  operationUrl,
  parseAuthorizationCode,
  projectFromLoadResponse,
  projectFromOperation,
  refreshCredential,
  resolveProjectId,
  withAntigravityAuth,
  type AntigravityCredential,
} from "./antigravity.ts";

/** `authorizeOAuth` only carries a URL while the login is still pending. */
function pendingUrl(result: { pending?: boolean; url?: string }): string | undefined {
  return result.pending ? result.url : undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function credential(overrides: Partial<AntigravityCredential> = {}): AntigravityCredential {
  return {
    kind: "antigravity",
    accessToken: "a-1",
    refreshToken: "r-1",
    projectId: "project-1",
    ...overrides,
  };
}

describe("Antigravity OAuth constants", () => {
  it("builds the PKCE challenge and authorization URL for the Antigravity client", () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).not.toContain("=");

    const url = new URL(
      buildAuthorizationUrl({
        kind: "antigravity",
        state: "state-1",
        challenge: pkce.challenge,
        redirectUri: "http://localhost:51121/oauth-callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toContain("1071006060591-");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")).toContain("cloud-platform");
  });

  it("reads a code from a bare string or a pasted redirect URL", () => {
    expect(parseAuthorizationCode(" 4/0Abc ")).toBe("4/0Abc");
    expect(
      parseAuthorizationCode("http://localhost:51121/oauth-callback?code=4%2Fxyz&state=s"),
    ).toBe("4/xyz");
    expect(parseAuthorizationCode("http://localhost:51121/oauth-callback?error=denied")).toBeUndefined();
    expect(parseAuthorizationCode("two words")).toBeUndefined();
  });
});

describe("Antigravity token handling", () => {
  it("exchanges the code and keeps the refresh token on later refreshes", async () => {
    const bodies: string[] = [];
    const exchange = await exchangeAuthorizationCode(
      async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        return jsonResponse(200, {
          access_token: "a-1",
          refresh_token: "r-1",
          expires_in: 3600,
        });
      },
      { kind: "antigravity", code: "code-1", verifier: "verifier-1" },
    );
    expect(exchange.accessToken).toBe("a-1");
    expect(exchange.refreshToken).toBe("r-1");
    expect(bodies[0]).toContain("grant_type=authorization_code");
    expect(bodies[0]).toContain("code_verifier=verifier-1");

    // Google does not rotate the refresh token on a plain refresh.
    const refreshed = await refreshCredential(async () => jsonResponse(200, {
      access_token: "a-2",
      expires_in: 1800,
    }), exchange);
    expect(refreshed.accessToken).toBe("a-2");
    expect(refreshed.refreshToken).toBe("r-1");
    expect(credentialNeedsRefresh({ ...refreshed, expiresAt: Date.now() - 1 })).toBe(true);
    expect(credentialNeedsRefresh({ ...refreshed, expiresAt: Date.now() + 3_600_000 })).toBe(false);
  });

  it("surfaces Google's error text", async () => {
    await expect(
      exchangeAuthorizationCode(async () => jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Bad code",
      }), { kind: "antigravity", code: "nope", verifier: "v" }),
    ).rejects.toThrow("Bad code");
  });
});

describe("Antigravity Cloud Code Assist", () => {
  it("targets the v1internal method URL", () => {
    expect(methodUrl("generateContent")).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    expect(methodUrl("fetchAvailableModels", "https://example.test/")).toBe(
      "https://example.test/v1internal:fetchAvailableModels",
    );
  });

  it("reads a project from loadCodeAssist and from an onboard operation", () => {
    expect(projectFromLoadResponse({ cloudaicompanionProject: "p-1" })).toBe("p-1");
    expect(projectFromLoadResponse({ cloudaicompanionProject: { id: "p-2" } })).toBe("p-2");
    expect(projectFromLoadResponse({})).toBeUndefined();
    expect(defaultTierFromLoadResponse({
      allowedTiers: [{ id: "legacy-tier" }, { id: "free-tier", isDefault: true }],
    })).toBe("free-tier");
    expect(projectFromOperation({ done: false, response: { cloudaicompanionProject: "p-3" } })).toBeUndefined();
    expect(projectFromOperation({ done: true, response: { cloudaicompanionProject: { id: "p-3" } } })).toBe("p-3");
  });

  it("resolves the project through loadCodeAssist without onboarding", async () => {
    const calls: string[] = [];
    const projectId = await resolveProjectId(async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { cloudaicompanionProject: "existing-project" });
    }, credential());
    expect(projectId).toBe("existing-project");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("loadCodeAssist");
  });

  it("onboards the default tier when the account has no project", async () => {
    const bodies: string[] = [];
    const projectId = await resolveProjectId(async (input, init) => {
      const url = String(input);
      bodies.push(String(init?.body ?? ""));
      if (url.includes("loadCodeAssist")) {
        return jsonResponse(200, { allowedTiers: [{ id: "free-tier", isDefault: true }] });
      }
      return jsonResponse(200, {
        name: "operations/op-1",
        done: true,
        response: { cloudaicompanionProject: { id: "provisioned" } },
      });
    }, credential());
    expect(projectId).toBe("provisioned");
    expect(bodies[1]).toContain("free-tier");
  });

  it("sends bearer, user agent, and client metadata on model fetches", async () => {
    const seen: { url: string; auth: string | null; metadata: string | null; body: string }[] = [];
    const models = await fetchAvailableModels(async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        auth: headers.get("authorization"),
        metadata: headers.get("client-metadata"),
        body: String(init?.body ?? ""),
      });
      return jsonResponse(200, {
        models: {
          "gemini-3-pro": { displayName: "Gemini 3 Pro" },
          "gemini-3-flash": {},
        },
      });
    }, credential());

    expect(models.map((model) => model.id)).toEqual(["gemini-3-flash", "gemini-3-pro"]);
    const first = seen[0];
    expect(first).toBeDefined();
    expect(first?.url).toContain("v1internal:fetchAvailableModels");
    expect(first?.auth).toBe("Bearer a-1");
    expect(first?.metadata).toContain("GEMINI");
    expect(first?.body).toBe(JSON.stringify({ project: "project-1" }));
  });

  it("returns no models when the account is not connected", async () => {
    const models = await fetchAvailableModels(async () => jsonResponse(200, { models: {} }), credential({ projectId: undefined }));
    expect(models).toEqual([]);
  });
});

describe("AntigravityCredentialStore", () => {
  it("round-trips a credential in a 0600 file", () => {
    const dir = mkdtempSync(join(tmpdir(), "thebe-antigravity-"));
    const store = new AntigravityCredentialStore(join(dir, "antigravity.json"));
    expect(store.get(ANTIGRAVITY_PROVIDER_ID)).toBeUndefined();
    store.set(ANTIGRAVITY_PROVIDER_ID, credential());
    expect(store.get(ANTIGRAVITY_PROVIDER_ID)?.accessToken).toBe("a-1");
    expect(JSON.parse(readFileSync(join(dir, "antigravity.json"), "utf8"))).toHaveProperty(
      ANTIGRAVITY_PROVIDER_ID,
    );
    expect(statSync(join(dir, "antigravity.json")).mode & 0o777).toBe(0o600);
    store.delete(ANTIGRAVITY_PROVIDER_ID);
    expect(store.get(ANTIGRAVITY_PROVIDER_ID)).toBeUndefined();
  });
});

describe("createAntigravityAuth", () => {
  function makeAuth(routes: (url: string) => Response) {
    const dir = mkdtempSync(join(tmpdir(), "thebe-antigravity-auth-"));
    const store = new AntigravityCredentialStore(join(dir, "antigravity.json"));
    const seen: string[] = [];
    const auth = createAntigravityAuth({
      store,
      fetchImpl: async (input, init) => {
        const url = String(input);
        seen.push(`${init?.method ?? "GET"} ${url}`);
        return routes(url);
      },
    });
    return { auth, store, seen };
  }

  it("reports the provider as missing until a login completes", async () => {
    const { auth, store } = makeAuth(() => jsonResponse(200, {}));
    expect(auth.providers()[0]).toMatchObject({
      id: ANTIGRAVITY_PROVIDER_ID,
      displayName: "Antigravity",
      authMethods: ["oauth"],
      authStatus: "missing",
    });

    const authorize = await auth.authorizeOAuth(ANTIGRAVITY_PROVIDER_ID);
    expect(authorize.connected).toBeFalsy();
    expect(authorize.pending).toBe(true);
    expect(pendingUrl(authorize)).toContain("client_id=1071006060591-");
    expect(auth.providers()[0]?.oauthPending).toBe(true);

    await expect(auth.submitOAuthCallback(ANTIGRAVITY_PROVIDER_ID, "")).rejects.toThrow(
      "authorization code is empty",
    );
    expect(store.get(ANTIGRAVITY_PROVIDER_ID)).toBeUndefined();
  });

  it("stores the credential after the code is submitted", async () => {
    const { auth, store } = makeAuth((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse(200, { access_token: "a-9", refresh_token: "r-9", expires_in: 3600 });
      }
      if (url.includes("userinfo")) {
        return jsonResponse(200, { email: "unitsung@example.com" });
      }
      return jsonResponse(200, { cloudaicompanionProject: "p-9" });
    });
    await auth.authorizeOAuth(ANTIGRAVITY_PROVIDER_ID);
    await auth.submitOAuthCallback(
      ANTIGRAVITY_PROVIDER_ID,
      "http://localhost:51121/oauth-callback?code=4%2Fabc&state=s",
    );

    const stored = store.get(ANTIGRAVITY_PROVIDER_ID);
    expect(stored?.accessToken).toBe("a-9");
    expect(stored?.refreshToken).toBe("r-9");
    expect(stored?.account).toBe("unitsung@example.com");
    expect(stored?.projectId).toBe("p-9");
    expect(auth.providers()[0]?.authStatus).toBe("connected");
    expect(await auth.check(ANTIGRAVITY_PROVIDER_ID)).toEqual({ ok: true });

    await auth.logout(ANTIGRAVITY_PROVIDER_ID);
    expect(auth.providers()[0]?.authStatus).toBe("missing");
  });

  it("refreshes on demand and lists models from fetchAvailableModels", async () => {
    const { auth, store } = makeAuth((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse(200, { access_token: "a-10", expires_in: 3600 });
      }
      return jsonResponse(200, { models: { "gemini-3-pro": { displayName: "Gemini 3 Pro" } } });
    });
    store.set(ANTIGRAVITY_PROVIDER_ID, credential({ expiresAt: Date.now() + 3_600_000 }));
    const models = await auth.models(ANTIGRAVITY_PROVIDER_ID);
    expect(models).toEqual([
      {
        providerId: ANTIGRAVITY_PROVIDER_ID,
        modelId: "gemini-3-pro",
        displayName: "Gemini 3 Pro",
        supportsThinking: true,
        available: true,
      },
    ]);

    const refreshed = await auth.credential(ANTIGRAVITY_PROVIDER_ID, { forceRefresh: true });
    expect(refreshed.accessToken).toBe("a-10");
    expect(store.get(ANTIGRAVITY_PROVIDER_ID)?.accessToken).toBe("a-10");
  });
});

describe("withAntigravityAuth", () => {
  const baseAuth = (): RuntimeAuth => ({
    async listProviders() {
      return [{ id: "openai", displayName: "OpenAI", authMethods: ["apiKey"] }];
    },
    async setApiKey() {},
    async loginOAuth(providerId) {
      return { kind: "oauth", providerId };
    },
    async authorizeOAuth(providerId) {
      return { providerId, connected: true } as OAuthAuthorizeResult;
    },
    async submitOAuthCallback() {},
    async logout() {},
    async check() {
      return { ok: true };
    },
    async testProvider() {
      return { ok: true, message: "base" };
    },
  });

  it("appends the Antigravity provider and routes its ids locally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thebe-antigravity-wrap-"));
    const store = new AntigravityCredentialStore(join(dir, "antigravity.json"));
    const antigravity = createAntigravityAuth({ store, fetchImpl: async () => jsonResponse(200, {}) });
    const auth = withAntigravityAuth(baseAuth(), antigravity);

    const providers = await auth.listProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["openai", ANTIGRAVITY_PROVIDER_ID]);

    const authorize = await auth.authorizeOAuth(ANTIGRAVITY_PROVIDER_ID, {});
    expect(pendingUrl(authorize)).toContain("accounts.google.com");
    expect(await auth.check(ANTIGRAVITY_PROVIDER_ID)).toEqual({ ok: false });
    expect((await auth.testProvider("openai")).message).toBe("base");
    await expect(auth.setApiKey(ANTIGRAVITY_PROVIDER_ID, "key")).rejects.toThrow("Google OAuth");
  });
});
