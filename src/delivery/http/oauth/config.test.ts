import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOAuthClients, resolveOAuthConfig } from "./config.ts";

const dir = () => mkdtemp(join(tmpdir(), "thebe-oauth-config-"));

describe("OAuth configuration", () => {
  it("is off until a stable public issuer is configured", async () => {
    expect(
      resolveOAuthConfig({ configDir: await dir(), env: {} })
    ).toBeUndefined();
    expect(() =>
      resolveOAuthConfig({
        configDir: "/tmp/thebe-oauth-config",
        env: {
          THEBE_OAUTH_ISSUER: "http://example.test",
          THEBE_OAUTH_CLIENTS: JSON.stringify([
            {
              clientId: "chatgpt",
              redirectUris: ["https://chatgpt.example/callback"],
            },
          ]),
        },
      })
    ).toThrow(/HTTPS outside localhost/);
  });

  it("loads pre-registered clients, defaults scopes, and derives the MCP resource", async () => {
    const config = resolveOAuthConfig({
      configDir: await dir(),
      env: {
        THEBE_OAUTH_ISSUER: "https://home.example",
        THEBE_OAUTH_CLIENTS: JSON.stringify([
          {
            clientId: "chatgpt",
            clientName: "ChatGPT",
            clientSecret: "secret",
            redirectUris: ["https://chatgpt.example/callback"],
          },
          {
            clientId: "claude",
            redirectUris: ["http://127.0.0.1/callback"],
            scopes: ["mcp:write", "offline_access"],
          },
        ]),
      },
    });
    expect(config?.resource).toBe("https://home.example/mcp");
    expect(config?.clients[0]).toMatchObject({
      client_id: "chatgpt",
      token_endpoint_auth_method: "client_secret_basic",
      scope: "mcp:read offline_access",
    });
    expect(config?.clients[1]).toMatchObject({
      client_id: "claude",
      token_endpoint_auth_method: "none",
      scope: "mcp:write offline_access",
    });
    expect(config?.dynamicRegistration).toBe(false);
  });

  it("reads the default private clients file and allows local development HTTP", async () => {
    const configDir = await dir();
    await writeFile(
      join(configDir, "oauth-clients.json"),
      JSON.stringify({
        clients: [
          {
            client_id: "local",
            client_name: "Local client",
            redirect_uris: ["http://localhost:3000/callback"],
          },
        ],
      }),
      { mode: 0o600 }
    );
    const config = resolveOAuthConfig({
      configDir,
      env: {
        THEBE_OAUTH_ISSUER: "http://localhost:8788",
        THEBE_MCP_RESOURCE_URL: "http://localhost:8788/mcp",
      },
    });
    expect(config?.clients.map((client) => client.client_id)).toEqual([
      "local",
    ]);
    expect(config?.clientsSource).toBe(join(configDir, "oauth-clients.json"));
  });

  it("requires a client unless dynamic registration is explicitly enabled", async () => {
    expect(() =>
      resolveOAuthConfig({
        configDir: "/tmp/thebe-empty-oauth",
        env: { THEBE_OAUTH_ISSUER: "https://home.example" },
      })
    ).toThrow(/pre-registered client/);
    expect(
      resolveOAuthConfig({
        configDir: "/tmp/thebe-empty-oauth",
        env: {
          THEBE_OAUTH_ISSUER: "https://home.example",
          THEBE_OAUTH_DYNAMIC_REGISTRATION: "true",
        },
      })?.dynamicRegistration
    ).toBe(true);
  });

  it("rejects duplicate ids, unsafe redirects, and unknown scopes", () => {
    const base = {
      clientId: "client",
      redirectUris: ["https://client.example/callback"],
    };
    expect(() => parseOAuthClients([base, base])).toThrow(/repeated/);
    expect(() =>
      parseOAuthClients([
        { ...base, redirectUris: ["http://example.test/callback"] },
      ])
    ).toThrow(/HTTPS except on localhost/);
    expect(() => parseOAuthClients([{ ...base, scopes: ["admin"] }])).toThrow(
      /unknown scope/
    );
  });
});
