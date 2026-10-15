import { randomBytes } from "node:crypto";
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
