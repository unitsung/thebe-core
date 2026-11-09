import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateOAuthKeys, oauthKeysPath } from "./keys.ts";

const dir = () => mkdtemp(join(tmpdir(), "thebe-oauth-keys-"));

describe("OAuth key persistence", () => {
  it("keeps signing and cookie keys across restart and stores them privately", async () => {
    const configDir = await dir();
    const first = await loadOrCreateOAuthKeys({
      configDir,
      issuer: "https://home.example",
      generateCookieKey: () => "cookie-key",
    });
    const second = await loadOrCreateOAuthKeys({
      configDir,
      issuer: "https://home.example",
      generateCookieKey: () => "different",
    });
    expect(second.cookieKeys).toEqual(first.cookieKeys);
    expect(second.jwks).toEqual(first.jwks);
    expect(first.jwks.keys[0]).toMatchObject({
      alg: "PS256",
      use: "sig",
    });
    expect((await stat(oauthKeysPath(configDir))).mode & 0o777).toBe(0o600);
    expect(await readFile(oauthKeysPath(configDir), "utf8")).toContain('"d"');
  });

  it("refuses a changed issuer so tokens cannot silently cross identities", async () => {
    const configDir = await dir();
    await loadOrCreateOAuthKeys({
      configDir,
      issuer: "https://home.example",
    });
    await expect(
      loadOrCreateOAuthKeys({
        configDir,
        issuer: "https://other.example",
      })
    ).rejects.toThrow(/refusing to change the issuer/);
  });

  it("does not replace corrupt key state", async () => {
    const configDir = await dir();
    const path = oauthKeysPath(configDir);
    await writeFile(path, "{");
    await expect(
      loadOrCreateOAuthKeys({ configDir, issuer: "https://home.example" })
    ).rejects.toThrow(/not valid JSON/);
    expect(await readFile(path, "utf8")).toBe("{");
  });
});
