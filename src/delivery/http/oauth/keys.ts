import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  type JWK,
} from "jose";
import type { JWKS } from "oidc-provider";
import { writeFileAtomicSync } from "../../../atomic-write.ts";

type StoredOAuthKeys = {
  version: 1;
  issuer: string;
  cookieKeys: string[];
  jwks: { keys: JWK[] };
};

export type OAuthKeyMaterial = {
  cookieKeys: string[];
  csrfSecret: Buffer;
  verificationKeys: JWTVerifyGetKey;
  jwks: JWKS;
};

export function oauthKeysPath(configDir: string): string {
  return join(configDir, "oauth-keys.json");
}

export async function loadOrCreateOAuthKeys(options: {
  configDir: string;
  issuer: string;
  generateCookieKey?: () => string;
}): Promise<OAuthKeyMaterial> {
  const path = oauthKeysPath(options.configDir);
  let stored: StoredOAuthKeys;
  if (existsSync(path)) {
    stored = parseStoredKeys(readFileSync(path, "utf8"), path);
    if (stored.issuer !== options.issuer) {
      throw new Error(
        `${path} belongs to issuer ${stored.issuer}; refusing to change the issuer to ${options.issuer}`
      );
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows and read-only filesystems may not support POSIX modes.
    }
  } else {
    const cookieKey =
      options.generateCookieKey ??
      (() =>
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""));
    const { privateKey } = await generateKeyPair("PS256", {
      extractable: true,
    });
    const privateJwk = {
      ...(await exportJWK(privateKey)),
      kid: randomUUID(),
      alg: "PS256",
      use: "sig",
    } satisfies JWK;
    stored = {
      version: 1,
      issuer: options.issuer,
      cookieKeys: [cookieKey()],
      jwks: { keys: [privateJwk] },
    };
    mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(path, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  const signingKey = stored.jwks.keys[0];
  if (!signingKey || typeof signingKey.kid !== "string") {
    throw new Error(`${path} does not contain a usable signing key`);
  }
  const verificationKeys = createLocalJWKSet({
    keys: stored.jwks.keys.map(publicJwk),
  });
  const firstCookieKey = stored.cookieKeys[0];
  if (!firstCookieKey) {
    throw new Error(`${path} does not contain a cookie key`);
  }
  return {
    cookieKeys: stored.cookieKeys,
    csrfSecret: Buffer.from(firstCookieKey, "utf8"),
    verificationKeys,
    jwks: stored.jwks as unknown as JWKS,
  };
}

function parseStoredKeys(text: string, path: string): StoredOAuthKeys {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} does not contain OAuth key state`);
  }
  const record = value as Partial<StoredOAuthKeys>;
  if (
    record.version !== 1 ||
    typeof record.issuer !== "string" ||
    !Array.isArray(record.cookieKeys) ||
    record.cookieKeys.length === 0 ||
    !record.cookieKeys.every(
      (key): key is string => typeof key === "string" && key.length > 0
    ) ||
    !record.jwks ||
    !Array.isArray(record.jwks.keys) ||
    record.jwks.keys.length === 0
  ) {
    throw new Error(`${path} does not contain valid OAuth key state`);
  }
  return record as StoredOAuthKeys;
}

function publicJwk(jwk: JWK): JWK {
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    oth: _oth,
    ...publicKey
  } = jwk;
  return publicKey;
}
