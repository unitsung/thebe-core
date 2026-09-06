import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env.local` from cwd, the Node entry, or by walking up from a start
 * directory. Bundled chunks live under `dist/chunks/`; the file stays at the
 * package root or next to `dist/*.js`.
 */
export function loadEnvLocal(
  fromDir = dirname(fileURLToPath(import.meta.url)),
): void {
  for (const path of envLocalCandidates(fromDir)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    applyEnvLocal(text);
    return;
  }
}

export function envLocalCandidates(fromDir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const starts = [fromDir, process.cwd()];
  const entry = process.argv[1];
  if (entry) {
    starts.push(dirname(entry));
  }
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (!seen.has(dir)) {
        seen.add(dir);
        out.push(join(dir, ".env.local"));
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return out;
}

function applyEnvLocal(text: string): void {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
