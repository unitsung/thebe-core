import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../../atomic-write.ts";

type AuthEntry = { type?: unknown; key?: unknown };

function readAuthFile(path: string): Record<string, AuthEntry> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("DSH auth file contains invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DSH auth file must contain a JSON object.");
  }
  return parsed as Record<string, AuthEntry>;
}

export function readDshApiKey(
  path: string,
  providerId: string
): string | undefined {
  const entry = readAuthFile(path)[providerId];
  if (
    typeof entry !== "object" ||
    entry === null ||
    entry.type !== "api_key" ||
    typeof entry.key !== "string" ||
    entry.key === "none"
  ) {
    return undefined;
  }
  return entry.key.trim() || undefined;
}

export function writeDshApiKey(
  path: string,
  providerId: string,
  apiKey: string | undefined
): void {
  const auth = readAuthFile(path);
  if (apiKey) {
    auth[providerId] = { type: "api_key", key: apiKey };
  } else {
    delete auth[providerId];
  }

  if (Object.keys(auth).length === 0) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
