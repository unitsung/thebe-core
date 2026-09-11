import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { PromptFile } from "./types.ts";
import { isInlineTextFile } from "./types.ts";

/** Decode base64 or read a path and return the selected line range. */
export function renderLinesSnippet(
  file: PromptFile,
  cwd = process.cwd(),
): string {
  const name = file.path ?? file.filename ?? "attachment";
  const start = Math.max(1, file.lineRange?.start ?? 1);
  const end = Math.max(start, file.lineRange?.end ?? start);
  const header = `[file snippet: ${name} lines ${start}-${end} (${file.mediaType})]`;
  const text = decodeFileText(file, cwd);
  if (text === undefined) {
    return header;
  }
  const lines = text.split(/\r?\n/);
  const sliced = lines.slice(start - 1, end).join("\n");
  return `${header}\n${sliced}`;
}

export function renderInlineTextFile(file: PromptFile): string {
  const name = file.filename ?? "attachment";
  let text = "";
  if (file.data) {
    try {
      text = Buffer.from(file.data, "base64").toString("utf8");
    } catch {
      text = "";
    }
  }
  return `[file: ${name} (${file.mediaType})]\n${text}`;
}

export function isInlineTextAttachment(file: PromptFile): boolean {
  return (
    (!file.mode || file.mode === "inline") &&
    Boolean(file.data) &&
    isInlineTextFile(file.mediaType)
  );
}

function decodeFileText(
  file: PromptFile,
  cwd: string,
): string | undefined {
  if (file.data) {
    try {
      return Buffer.from(file.data, "base64").toString("utf8");
    } catch {
      return undefined;
    }
  }
  if (!file.path) {
    return undefined;
  }
  try {
    const resolved = isAbsolute(file.path) ? file.path : join(cwd, file.path);
    return readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}
