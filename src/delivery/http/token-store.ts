import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../../atomic-write.ts";

/**
 * The shared token as a value the server asks for on every request, so rotating or revoking it
 * takes effect at once with no restart. A source that answers nothing means "locked": every
 * protected request is refused, which is what a revoked or unreadable token file must do.
 */
export type TokenSource = () => string | undefined;

export function tokenFilePath(configDir: string): string {
  return join(configDir, "token");
}

/** Reads `{configDir}/token`, re-reading only when the file changes. */
export function fileTokenSource(path: string): TokenSource {
  let stamp = "";
  let cached: string | undefined;
  return () => {
    try {
      const stat = statSync(path);
      const next = `${stat.mtimeMs}:${stat.size}`;
      if (next !== stamp) {
        cached = readFileSync(path, "utf8").trim() || undefined;
        stamp = next;
      }
      return cached;
    } catch {
      stamp = "";
      cached = undefined;
      return undefined;
    }
  };
}

export type TokenChange =
  | { ok: true; token: string; path: string }
  | { ok: false; reason: "managed-by-env" };

/**
 * Replaces the token with a fresh 32-byte one; the old one stops working as soon as a running Core
 * next checks the file. `THEBE_TOKEN` in the environment is the operator's own and is not touched.
 */
export function rotateToken(options: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  generate?: () => string;
}): TokenChange {
  const env = options.env ?? process.env;
  if (env.THEBE_TOKEN?.trim()) return { ok: false, reason: "managed-by-env" };
  const token = (options.generate ?? (() => randomBytes(32).toString("hex")))();
  const path = tokenFilePath(options.configDir);
  writeFileAtomicSync(path, `${token}\n`, { mode: 0o600 });
  return { ok: true, token, path };
}

/** Rotates to a token nobody sees: access is closed until the operator runs `rotate`. */
export function revokeToken(options: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  generate?: () => string;
}): TokenChange {
  const result = rotateToken(options);
  return result.ok ? { ...result, token: "" } : result;
}

export function tokenStatus(options: { configDir: string; env?: NodeJS.ProcessEnv }): {
  managedBy: "env" | "file" | "none";
  path: string;
  modifiedAt?: Date;
} {
  const env = options.env ?? process.env;
  const path = tokenFilePath(options.configDir);
  if (env.THEBE_TOKEN?.trim()) return { managedBy: "env", path };
  if (!existsSync(path)) return { managedBy: "none", path };
  return { managedBy: "file", path, modifiedAt: statSync(path).mtime };
}


// ---- Per-device tokens ----------------------------------------------------------------------

/** What the HTTP handler asks: whose token is this, if it is one of ours. */
export type TokenVerifier = { verify(received: string): string | undefined };

export type DeviceToken = { name: string; hash: string; createdAt: string };

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const RESERVED_NAMES = new Set(["default", "env"]);
/** Last-use times are saved at most this often, so a busy client does not write a file per request. */
const USAGE_FLUSH_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const hex = (value: string) => sha256(value).toString("hex");

export function deviceTokensPath(configDir: string): string {
  return join(configDir, "tokens.json");
}
function usagePath(configDir: string): string {
  return join(configDir, "token-usage.json");
}

export function readDeviceTokens(configDir: string): DeviceToken[] {
  try {
    const parsed = JSON.parse(readFileSync(deviceTokensPath(configDir), "utf8")) as { tokens?: unknown };
    return Array.isArray(parsed.tokens)
      ? parsed.tokens.filter(
          (t): t is DeviceToken =>
            !!t && typeof (t as DeviceToken).name === "string" && typeof (t as DeviceToken).hash === "string"
        )
      : [];
  } catch {
    return [];
  }
}

function writeDeviceTokens(configDir: string, tokens: DeviceToken[]): void {
  writeFileAtomicSync(deviceTokensPath(configDir), `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readTokenUsage(configDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(usagePath(configDir), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export type DeviceTokenResult =
  | { ok: true; name: string; token: string }
  | { ok: false; reason: "invalid-name" | "reserved-name" | "exists" };

/** Makes a token for one device. It is shown once; only its hash is kept. */
export function createDeviceToken(options: {
  configDir: string;
  name: string;
  now?: () => Date;
  generate?: () => string;
}): DeviceTokenResult {
  const name = options.name.trim();
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: "invalid-name" };
  if (RESERVED_NAMES.has(name.toLowerCase())) return { ok: false, reason: "reserved-name" };
  const existing = readDeviceTokens(options.configDir);
  if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) return { ok: false, reason: "exists" };
  const token = (options.generate ?? (() => randomBytes(32).toString("hex")))();
  existing.push({ name, hash: hex(token), createdAt: (options.now?.() ?? new Date()).toISOString() });
  writeDeviceTokens(options.configDir, existing);
  return { ok: true, name, token };
}

/** Removes one device's token; the others keep working. */
export function revokeDeviceToken(options: { configDir: string; name: string }): boolean {
  const existing = readDeviceTokens(options.configDir);
  const kept = existing.filter((t) => t.name.toLowerCase() !== options.name.trim().toLowerCase());
  if (kept.length === existing.length) return false;
  writeDeviceTokens(options.configDir, kept);
  return true;
}

export function revokeAllDeviceTokens(configDir: string): number {
  const existing = readDeviceTokens(configDir);
  if (existing.length) writeDeviceTokens(configDir, []);
  return existing.length;
}

/**
 * Accepts the `THEBE_TOKEN` environment token, the token file (`default`), and every device token in
 * `tokens.json`, re-reading the files as they change so a create or revoke applies at once. Nothing
 * configured means nothing is accepted.
 */
export function createTokenVerifier(options: {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  /** Used as `default` only while the token file does not exist (it could not be written). */
  fallback?: string;
  now?: () => number;
}): TokenVerifier {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fileToken = fileTokenSource(tokenFilePath(options.configDir));
  let listStamp = "";
  let devices: DeviceToken[] = [];
  const used = new Map<string, string>();
  const flushed = new Map<string, number>();

  const loadDevices = () => {
    try {
      const stat = statSync(deviceTokensPath(options.configDir));
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp !== listStamp) {
        devices = readDeviceTokens(options.configDir);
        listStamp = stamp;
      }
    } catch {
      devices = [];
      listStamp = "";
    }
    return devices;
  };
  const noteUse = (name: string) => {
    used.set(name, new Date(now()).toISOString());
    if (now() - (flushed.get(name) ?? 0) >= USAGE_FLUSH_MS) {
      flushed.set(name, now());
      try {
        writeFileAtomicSync(usagePath(options.configDir), `${JSON.stringify({ ...readTokenUsage(options.configDir), ...Object.fromEntries(used) })}\n`, { mode: 0o600 });
      } catch {
        // Usage is a convenience; a failed write must not fail the request.
      }
    }
  };

  return {
    verify(received) {
      if (!received) return undefined;
      const digest = sha256(received);
      const same = (candidate: Buffer) => candidate.length === digest.length && timingSafeEqual(candidate, digest);
      const envToken = env.THEBE_TOKEN?.trim();
      if (envToken && same(sha256(envToken))) return "env";
      const file = fileToken() ?? (existsSync(tokenFilePath(options.configDir)) ? undefined : options.fallback);
      if (file && same(sha256(file))) return "default";
      let found: string | undefined;
      for (const device of loadDevices()) {
        if (same(Buffer.from(device.hash, "hex"))) found = device.name;
      }
      if (found) noteUse(found);
      return found;
    },
  };
}
