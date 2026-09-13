import type { PromptFile, PromptMode } from "../../../agent/index.ts";
import {
  estimatedDecodedBytes,
  isSupportedPromptFile,
  MAX_PROMPT_FILES,
  MAX_PROMPT_FILE_BYTES,
  MAX_INLINE_FILE_BYTES,
} from "../../../agent/runtime/index.ts";
import { asObject, readJson } from "../json.ts";

export function parseMode(value: unknown): PromptMode | undefined {
  if (value === "steer" || value === "followUp" || value === "prompt") return value;
  return undefined;
}

export type ParsedPromptBody =
  | { ok: true; text: string; mode: PromptMode; files: PromptFile[]; sessionId?: string; stream?: boolean }
  | { ok: false; error: string; status?: number };

export async function readPromptBody(request: Request): Promise<ParsedPromptBody> {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text : "";
  const mode = body.mode === undefined ? "prompt" : parseMode(body.mode);
  if (!mode) return { ok: false, error: "invalid mode; want prompt, steer, or followUp" };
  const filesResult = parsePromptFiles(body.files);
  if (!filesResult.ok) return filesResult;
  if (!text.trim() && filesResult.files.length === 0) return { ok: false, error: "text or files required" };
  const sessionId = typeof body.sessionId === "string"
    ? body.sessionId
    : typeof body.thebeSessionId === "string" ? body.thebeSessionId : undefined;
  return { ok: true, text, mode, files: filesResult.files, sessionId, stream: body.stream === true };
}

function parsePromptFiles(value: unknown):
  | { ok: true; files: PromptFile[] }
  | { ok: false; error: string; status?: number } {
  if (value === undefined) return { ok: true, files: [] };
  if (!Array.isArray(value)) return { ok: false, error: "files must be an array" };
  if (value.length > MAX_PROMPT_FILES) {
    return { ok: false, error: `too many files; maximum is ${MAX_PROMPT_FILES}` };
  }
  const files: PromptFile[] = [];
  for (const item of value) {
    const row = asObject(item);
    const mediaType = typeof row.mediaType === "string" ? row.mediaType : "";
    if (!mediaType) return { ok: false, error: "each file needs mediaType" };
    if (!isSupportedPromptFile(mediaType)) return { ok: false, error: `unsupported media type: ${mediaType}` };
    const mode = row.mode === "reference" || row.mode === "lines" || row.mode === "inline" ? row.mode : "inline";
    const filename = typeof row.filename === "string" ? row.filename : undefined;
    const path = typeof row.path === "string" ? row.path : undefined;
    const data = typeof row.data === "string" ? row.data : undefined;
    const lineRange = row.lineRange && typeof row.lineRange === "object"
      ? { start: Number((row.lineRange as Record<string, unknown>).start) || 1, end: Number((row.lineRange as Record<string, unknown>).end) || 1 }
      : undefined;
    if (mode === "reference") {
      if (!path && !filename) return { ok: false, error: "reference mode requires path or filename" };
      files.push({ mode: "reference", mediaType, path, filename });
      continue;
    }
    if (mode === "lines") {
      if (!path && !filename && !data) return { ok: false, error: "lines mode requires path, filename, or data" };
      files.push({ mode: "lines", mediaType, path, filename, lineRange, data });
      continue;
    }
    if (!data) return { ok: false, error: "inline mode requires data" };
    const decodedBytes = estimatedDecodedBytes(data);
    if (decodedBytes > MAX_PROMPT_FILE_BYTES) {
      return { ok: false, status: 413, error: `file too large; maximum is ${MAX_PROMPT_FILE_BYTES} bytes decoded` };
    }
    files.push(decodedBytes > MAX_INLINE_FILE_BYTES && (path || filename)
      ? { mode: "reference", mediaType, path, filename }
      : { mode: "inline", mediaType, data, filename, path });
  }
  return { ok: true, files };
}
