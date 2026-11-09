import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "../handler.ts";
import { listenThebeHttp } from "../listen.ts";
import { createMcpOnlyHandler } from "../mcp-only.ts";
import { resolveOAuthConfig } from "./config.ts";
import { createOAuthAdapter } from "./adapter.ts";
import { oauthKeysPath } from "./keys.ts";
import { createThebeOAuth } from "./service.ts";

async function oauthFixture() {
  const port = await availablePort();
  const configDir = await mkdtemp(join(tmpdir(), "thebe-oauth-service-"));
  const issuer = `http://127.0.0.1:${port}`;
  const config = resolveOAuthConfig({
    configDir,
    env: {
      THEBE_OAUTH_ISSUER: issuer,
      THEBE_OAUTH_CLIENTS: JSON.stringify([
        {
          clientId: "test-client",
          clientName: "Test client",
          clientSecret: "test-secret",
          redirectUris: [`${issuer}/callback`],
          scopes: [
            "mcp:read",
            "mcp:write",
            "mcp:irreversible",
            "offline_access",
          ],
        },
      ]),
    },
  });
  if (!config) throw new Error("OAuth config was not created");
  const oauth = await createThebeOAuth({
    configDir,
    config,
    allowedHosts: ["127.0.0.1", `127.0.0.1:${port}`],
  });
  const app = createThebeHttpHandler({ version: "t", oauth });
  const listener = await listenThebeHttp(createMcpOnlyHandler(app), {
    host: "127.0.0.1",
    port,
    nodeMiddleware: (request, response) => oauth.handleNode(request, response),
  });
  return {
    configDir,
    config,
    oauth,
    url: config.issuer,
    baseUrl: issuer.replace(/\/$/, ""),
    close: () =>
      new Promise<void>((resolve, reject) => {
        listener.server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("no test port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe("OAuth service", () => {
  it("serves discovery, protected-resource metadata, and an RFC 9728 challenge", async () => {
    const fixture = await oauthFixture();
    try {
      const discovery = await fetch(
        `${fixture.baseUrl}/.well-known/oauth-authorization-server`
      );
      expect(discovery.status).toBe(200);
      await expect(discovery.json()).resolves.toMatchObject({
        issuer: fixture.url,
        authorization_endpoint: `${fixture.baseUrl}/oauth/authorize`,
        token_endpoint: `${fixture.baseUrl}/oauth/token`,
        revocation_endpoint: `${fixture.baseUrl}/oauth/revoke`,
        code_challenge_methods_supported: ["S256"],
      });

      const metadata = await fetch(
        `${fixture.baseUrl}/.well-known/oauth-protected-resource/mcp`
      );
      expect(metadata.status).toBe(200);
      await expect(metadata.json()).resolves.toEqual({
        resource: `${fixture.baseUrl}/mcp`,
        authorization_servers: [fixture.url],
        scopes_supported: ["mcp:read", "mcp:write", "mcp:irreversible"],
        bearer_methods_supported: ["header"],
        resource_name: "Thebe MCP gateway",
      });

      const mcp = await fetch(`${fixture.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
        }),
      });
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${fixture.baseUrl}/.well-known/oauth-protected-resource/mcp"`
      );
    } finally {
      await fixture.close();
    }
  });

  it("completes Authorization Code + PKCE and rejects a revoked or wrong-audience JWT", async () => {
    const fixture = await oauthFixture();
    try {
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const authorize = new URL("/oauth/authorize", fixture.baseUrl);
      authorize.search = new URLSearchParams({
        response_type: "code",
        client_id: "test-client",
        redirect_uri: `${fixture.baseUrl}/callback`,
        scope: "mcp:read mcp:write mcp:irreversible offline_access",
        prompt: "consent",
        resource: fixture.config.resource,
        state: "state-123",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      const jar = new CookieJar();
      const started = await jar.fetch(authorize, { redirect: "manual" });
      expect(started.status).toBe(303);
      const interactionUrl = requiredLocation(started);
      expect(interactionUrl.pathname).toMatch(/^\/oauth\/interaction\//);

      const page = await jar.fetch(interactionUrl);
      expect(page.status).toBe(200);
      const pageText = await page.text();
      const csrf = pageText.match(/name="csrf" value="([^"]+)"/)?.[1];
      expect(csrf).toBeTruthy();
      expect(pageText).toContain("Test client");
      expect(pageText).toContain("mcp:read");
      expect(pageText).toContain("mcp:write");
      expect(pageText).toContain("mcp:irreversible");

      const issuedPairing = fixture.oauth.issuePairingCode();
      const interactionForm = new URLSearchParams({
        csrf: csrf!,
        code: issuedPairing.code,
        decision: "approve",
      });
      interactionForm.append("scope", "mcp:read");
      interactionForm.append("scope", "mcp:write");
      interactionForm.append("scope", "offline_access");
      const finished = await jar.fetch(interactionUrl, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: interactionForm,
      });
      expect(finished.status).toBe(303);
      const resumed = await jar.fetch(requiredLocation(finished), {
        redirect: "manual",
      });
      expect(resumed.status).toBe(303);
      const callback = requiredLocation(resumed);
      expect(callback.origin).toBe(fixture.baseUrl);
      expect(callback.pathname).toBe("/callback");
      expect(callback.searchParams.get("state")).toBe("state-123");
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenResponse = await fetch(`${fixture.baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(
            "test-client:test-secret"
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: `${fixture.baseUrl}/callback`,
          code_verifier: verifier,
        }),
      });
      expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(
        200
      );
      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token?: string;
        scope: string;
      };
      expect(tokens.refresh_token).toBeTruthy();
      const accessClaims = decodeJwt(tokens.access_token);
      expect(accessClaims).toMatchObject({
        iss: fixture.url,
        aud: fixture.config.resource,
        client_id: "test-client",
        client_name: "Test client",
      });
      expect(String(accessClaims.scope).split(" ").sort()).toEqual([
        "mcp:read",
        "mcp:write",
      ]);
      await expect(fixture.oauth.verify(tokens.access_token)).resolves.toEqual({
        name: "Test client",
        scopes: ["mcp:read", "mcp:write"],
      });

      const mcp = await fetch(`${fixture.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "ping",
        }),
      });
      expect(mcp.status).toBe(200);

      const restarted = await createThebeOAuth({
        configDir: fixture.configDir,
        config: fixture.config,
        allowedHosts: ["127.0.0.1", new URL(fixture.baseUrl).host],
      });
      await expect(
        restarted.verify(tokens.access_token)
      ).resolves.toMatchObject({
        name: "Test client",
      });

      const keyFile = JSON.parse(
        await readFile(oauthKeysPath(fixture.configDir), "utf8")
      ) as {
        jwks: {
          keys: Array<Record<string, unknown> & { kid: string }>;
        };
      };
      const privateJwk = keyFile.jwks.keys[0];
      if (!privateJwk) throw new Error("missing OAuth signing key");
      const signingKey = await importJWK(privateJwk, "PS256");
      const wrongAudience = await new SignJWT({
        client_id: "test-client",
        scope: "mcp:read",
      })
        .setProtectedHeader({
          alg: "PS256",
          kid: privateJwk.kid,
          typ: "at+jwt",
        })
        .setIssuer(fixture.url)
        .setAudience(`${fixture.baseUrl}/not-mcp`)
        .setJti("wrong-audience")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signingKey);
      await expect(
        fixture.oauth.verify(wrongAudience)
      ).resolves.toBeUndefined();
      const wrongIssuer = await new SignJWT({
        client_id: "test-client",
        scope: "mcp:read",
      })
        .setProtectedHeader({
          alg: "PS256",
          kid: privateJwk.kid,
          typ: "at+jwt",
        })
        .setIssuer("https://other.example/")
        .setAudience(fixture.config.resource)
        .setJti("wrong-issuer")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signingKey);
      await expect(fixture.oauth.verify(wrongIssuer)).resolves.toBeUndefined();

      const revoked = await fetch(`${fixture.baseUrl}/oauth/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(
            "test-client:test-secret"
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          token: tokens.refresh_token!,
          token_type_hint: "refresh_token",
        }),
      });
      expect(revoked.status).toBe(200);
      await expect(
        fixture.oauth.verify(tokens.access_token)
      ).resolves.toBeUndefined();
      const afterRevoke = await fetch(`${fixture.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "ping",
        }),
      });
      expect(afterRevoke.status).toBe(401);
    } finally {
      await fixture.close();
    }
  });

  it("lists and revokes a connector grant, including its active tokens", async () => {
    const fixture = await oauthFixture();
    try {
      const grant = new fixture.oauth.provider.Grant({
        accountId: "thebe-owner",
        clientId: "test-client",
      });
      grant.addOIDCScope(["offline_access"]);
      grant.addResourceScope(fixture.config.resource, [
        "mcp:read",
        "mcp:write",
      ]);
      const grantId = await grant.save();

      const Adapter = createOAuthAdapter(fixture.configDir);
      await new Adapter("AccessToken").upsert("managed-access", {
        jti: "managed-access",
        kind: "AccessToken",
        clientId: "test-client",
        grantId,
        scope: "mcp:read mcp:write",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      await new Adapter("RefreshToken").upsert("managed-refresh", {
        jti: "managed-refresh",
        kind: "RefreshToken",
        clientId: "test-client",
        grantId,
        scope: "mcp:read mcp:write",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      await expect(fixture.oauth.listConnections()).resolves.toEqual([
        expect.objectContaining({
          id: grantId,
          clientId: "test-client",
          clientName: "Test client",
          scopes: expect.arrayContaining([
            "mcp:read",
            "mcp:write",
            "offline_access",
          ]),
          refreshToken: true,
        }),
      ]);
      await expect(fixture.oauth.revokeConnection(grantId)).resolves.toBe(true);
      await expect(fixture.oauth.listConnections()).resolves.toEqual([]);
      await expect(
        fixture.oauth.provider.AccessToken.find("managed-access")
      ).resolves.toBeUndefined();
      await expect(
        fixture.oauth.provider.RefreshToken.find("managed-refresh")
      ).resolves.toBeUndefined();
      await expect(fixture.oauth.revokeConnection(grantId)).resolves.toBe(
        false
      );
    } finally {
      await fixture.close();
    }
  });

  it("uses dynamically registered client metadata for a connection name", async () => {
    const fixture = await oauthFixture();
    try {
      const Adapter = createOAuthAdapter(fixture.configDir);
      await new Adapter("Client").upsert("dynamic-client", {
        client_id: "dynamic-client",
        client_name: "Dynamic connector",
        redirect_uris: [`${fixture.baseUrl}/dynamic-callback`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
      const grant = new fixture.oauth.provider.Grant({
        accountId: "thebe-owner",
        clientId: "dynamic-client",
      });
      grant.addResourceScope(fixture.config.resource, ["mcp:read"]);
      await grant.save();

      await expect(fixture.oauth.listConnections()).resolves.toEqual([
        expect.objectContaining({
          clientId: "dynamic-client",
          clientName: "Dynamic connector",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});

class CookieJar {
  private readonly cookies = new Map<string, string>();

  async fetch(input: URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
      );
    }
    const response = await fetch(input, { ...init, headers });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return response;
  }
}

function requiredLocation(response: Response): URL {
  const location = response.headers.get("location");
  if (!location) throw new Error(`missing Location on ${response.status}`);
  return new URL(location, response.url);
}
