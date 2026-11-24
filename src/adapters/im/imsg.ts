import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type {
  ImAccount,
  ImAdapter,
  ImAdapterCredentials,
  ImCapabilities,
  ImHealth,
  ImInbound,
  ImMediaRef,
  ImMediaFetchResult,
  ImSendResult,
} from "../../agent/im/types.ts";

export const IMESSAGE_MAX_TEXT = 10_000;
const DEFAULT_RETRY_MS = 3_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type ImsgCliRunner = {
  watch(input: {
    cliPath: string;
    args: string[];
    signal: AbortSignal;
    onLine(line: string): void;
    onDiagnostic(line: string): void;
  }): Promise<void>;
  send(input: {
    cliPath: string;
    args: string[];
    signal: AbortSignal;
  }): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

export function validateImsgCredentials(
  credentials: ImAdapterCredentials
): string | undefined {
  const cliPath = credentials.cliPath?.trim() || "imsg";
  if (/[\0\r\n]|(^|\s)--?\S/.test(cliPath)) {
    return "cliPath must be one executable path without shell arguments";
  }
  if (credentials.dbPath && /\0/.test(credentials.dbPath)) {
    return "dbPath must not contain a NUL byte";
  }
  return undefined;
}

export function imsgCursorIdentity(credentials: ImAdapterCredentials): string {
  return `imsg:${createHash("sha256")
    .update(
      JSON.stringify({
        cliPath: expandHome(credentials.cliPath?.trim() || "imsg"),
        dbPath: expandHome(credentials.dbPath?.trim() || ""),
      })
    )
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * iMessage through the installed `imsg` executable on the signed-in Messages Mac.
 * `watch --json --since-rowid` is both the live feed and restart cursor. Sending
 * uses `--chat-id`, never a display name, and arguments go directly to spawn.
 */
export function createImsgLocalAdapter(input: {
  account: ImAccount;
  credentials: ImAdapterCredentials;
  cursor?: string;
  onCursor(cursor: string): void;
  onError?(message: string): void;
  runner?: ImsgCliRunner;
  now?: () => Date;
  retryMs?: number;
  /** Tests and non-default Messages homes. Default: ~/Library/Messages/Attachments. */
  attachmentRoots?: readonly string[];
}): ImAdapter {
  const now = input.now ?? (() => new Date());
  const cliPath = expandHome(input.credentials.cliPath?.trim() || "imsg");
  const dbPath =
    expandHome(input.credentials.dbPath?.trim() || "") || undefined;
  const runner = input.runner ?? createNodeImsgRunner();
  const retryMs = Math.max(1, input.retryMs ?? DEFAULT_RETRY_MS);
  const attachmentRoots = input.attachmentRoots ?? [
    join(homedir(), "Library", "Messages", "Attachments"),
  ];
  const capabilities: ImCapabilities = {
    proactive: true,
    replyOnly: false,
    recall: false,
    media: true,
    maxTextLength: IMESSAGE_MAX_TEXT,
    markdown: false,
    threads: false,
    typing: false,
  };
  let health: ImHealth = { state: "stopped" };
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let inbound: ((message: ImInbound) => Promise<void>) | undefined;
  let inboundChain: Promise<void> = Promise.resolve();
  let cursor = parseCursor(input.cursor);
  let diagnostic = "";

  function setHealth(next: ImHealth): void {
    health = next;
    if (next.state === "error" && next.detail) input.onError?.(next.detail);
    if (next.state === "needs_login" && next.detail) {
      input.onError?.(next.detail);
    }
  }

  function baseArgs(): string[] {
    return dbPath ? ["--db", dbPath] : [];
  }

  function watchArgs(): string[] {
    return [
      "watch",
      "--json",
      ...baseArgs(),
      ...(cursor !== undefined ? ["--since-rowid", String(cursor)] : []),
    ];
  }

  function consume(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const row = parsed as Record<string, unknown>;
    const message = parseImsgMessage(row, input.account.id, now());
    if (message) {
      setHealth({ state: "connected", since: now().toISOString() });
      const handler = inbound;
      if (handler) {
        inboundChain = inboundChain
          .then(() => handler(message))
          .catch(() => {
            // The gateway persists the message first; one poison row must not stop the watcher.
          });
      }
    }
    if (row.type === undefined) {
      const next = numeric(row.id);
      if (next !== undefined && (cursor === undefined || next > cursor)) {
        cursor = next;
        input.onCursor(String(next));
      }
    }
  }

  async function watchLoop(active: AbortController): Promise<void> {
    let delay = retryMs;
    while (!active.signal.aborted) {
      diagnostic = "";
      try {
        setHealth({ state: "starting", since: now().toISOString() });
        await runner.watch({
          cliPath,
          args: watchArgs(),
          signal: active.signal,
          onLine: consume,
          onDiagnostic: (line) => {
            diagnostic = line.trim().slice(0, 300);
          },
        });
        if (active.signal.aborted) return;
        throw new Error(diagnostic || "imsg watch exited");
      } catch (error) {
        if (active.signal.aborted) return;
        const detail =
          diagnostic ||
          (error instanceof Error ? error.message : "imsg watch failed");
        const permission =
          /full disk access|operation not permitted|chat\.db|permission/i.test(
            detail
          );
        setHealth({
          state: permission ? "needs_login" : "error",
          detail: permission
            ? "imsg needs Full Disk Access and Messages automation permission"
            : detail,
          ...(permission ? { code: "permission_required" } : {}),
          since: now().toISOString(),
        });
        await sleep(delay, active.signal);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  return {
    platform: "imessage",
    capabilities,
    async start() {
      if (loop) return;
      if (validateImsgCredentials(input.credentials)) {
        setHealth({
          state: "needs_login",
          detail: validateImsgCredentials(input.credentials),
          code: "invalid_credentials",
        });
        return;
      }
      controller = new AbortController();
      loop = watchLoop(controller);
    },
    async stop() {
      controller?.abort();
      await loop?.catch(() => undefined);
      loop = undefined;
      controller = undefined;
      setHealth({ state: "stopped" });
    },
    async health() {
      return { ...health };
    },
    async send(message): Promise<ImSendResult> {
      const text = message.text.trim();
      if (!text && !message.media?.length) {
        return { status: "discard", reason: "empty_text" };
      }
      if ((message.media?.length ?? 0) > 1) {
        return { status: "discard", reason: "one_media_per_message" };
      }
      if (validateImsgCredentials(input.credentials)) {
        return { status: "discard", reason: "invalid_credentials" };
      }
      const active = controller ?? new AbortController();
      let temporaryDirectory: string | undefined;
      try {
        let file: string | undefined;
        const media = message.media?.[0];
        if (media) {
          const bytes = Buffer.from(media.data, "base64");
          if (bytes.length === 0 || bytes.length > 2_000_000) {
            return { status: "discard", reason: "invalid_media" };
          }
          temporaryDirectory = await mkdtemp(join(tmpdir(), "thebe-imsg-"));
          file = join(
            temporaryDirectory,
            safeFilename(media.filename) ?? fileForMediaType(media.mediaType)
          );
          await writeFile(file, bytes, { mode: 0o600 });
        }
        const result = await runner.send({
          cliPath,
          args: [
            "send",
            "--chat-id",
            message.chat.id,
            ...(text ? ["--text", truncateImessageText(text)] : []),
            ...(file ? ["--file", file] : []),
            "--json",
            ...baseArgs(),
          ],
          signal: active.signal,
        });
        if (result.code !== 0) {
          const detail = (result.stderr || result.stdout).trim().slice(0, 300);
          return {
            status: /not found|no such/i.test(detail) ? "discard" : "retry",
            reason: detail || `imsg exited ${result.code ?? "without status"}`,
          };
        }
        const payload = lastJsonObject(result.stdout) ?? {};
        const status = stringValue(payload?.status);
        if (status === "sent") {
          setHealth({ state: "connected", since: now().toISOString() });
          const id =
            stringValue(payload.guid) ??
            (payload.id !== undefined ? String(payload.id) : undefined);
          return { status: "sent", ...(id ? { platformMessageId: id } : {}) };
        }
        if (status === "may_have_completed") {
          return {
            status: "unknown",
            reason: "imsg could not confirm whether Messages sent the row",
          };
        }
        return {
          status: "unknown",
          reason: "imsg returned no confirmed send status",
        };
      } catch (error) {
        return {
          status: active.signal.aborted ? "discard" : "retry",
          reason:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "imsg failed",
        };
      } finally {
        if (temporaryDirectory) {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(
            () => {}
          );
        }
      }
    },
    onInbound(handler) {
      inbound = handler;
    },
    async fetchMedia(mediaInput): Promise<ImMediaFetchResult> {
      const source = mediaInput.media.id.startsWith("file://")
        ? new URL(mediaInput.media.id).pathname
        : mediaInput.media.id;
      const target = await realpath(resolve(source));
      let allowed = false;
      for (const root of attachmentRoots) {
        const canonicalRoot = await realpath(root).catch(() => undefined);
        if (!canonicalRoot) continue;
        const pathWithinRoot = relative(canonicalRoot, target);
        if (
          pathWithinRoot &&
          !pathWithinRoot.startsWith("..") &&
          !pathWithinRoot.startsWith("/")
        ) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        throw new Error("imsg attachment is outside the Messages store");
      }
      const details = await stat(target);
      if (!details.isFile() || details.size <= 0 || details.size > 2_000_000) {
        throw new Error("imsg attachment is too large");
      }
      return {
        data: new Uint8Array(await readFile(target)),
        mediaType:
          mediaInput.media.mimeType ??
          mediaTypeForFile(target) ??
          "application/octet-stream",
        filename: basename(target),
      };
    },
  };
}

export function truncateImessageText(
  text: string,
  max = IMESSAGE_MAX_TEXT
): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function parseImsgMessage(
  row: Record<string, unknown>,
  accountId: string,
  at: Date
): ImInbound | undefined {
  if (
    row.is_from_me === true ||
    (row.type !== undefined && row.type !== "new")
  ) {
    return undefined;
  }
  const chatId = scalar(row.chat_id);
  const messageId = stringValue(row.guid) ?? scalar(row.id);
  const sender = stringValue(row.sender);
  if (!chatId || !messageId || !sender) return undefined;
  const text = stringValue(row.text)?.trim() ?? "";
  const media = mediaOf(row.attachments);
  if (!text && media.length === 0) return undefined;
  const chatName = stringValue(row.chat_name);
  const senderName = stringValue(row.sender_name);
  const createdAt = stringValue(row.created_at);
  const parsedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  return {
    platform: "imessage",
    accountId,
    chat: {
      kind: row.is_group === true ? "group" : "direct",
      id: chatId,
      ...(chatName ? { title: chatName.slice(0, 200) } : {}),
    },
    sender: {
      id: sender,
      ...(senderName ? { name: senderName.slice(0, 100) } : {}),
    },
    messageId,
    text: text.slice(0, 16_000),
    replyTo: messageId,
    ...(media.length > 0 ? { media } : {}),
    receivedAt: Number.isFinite(parsedAt)
      ? new Date(parsedAt).toISOString()
      : at.toISOString(),
  };
}

function mediaOf(value: unknown): ImMediaRef[] {
  if (!Array.isArray(value)) return [];
  const found: ImMediaRef[] = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id =
      stringValue(row.path) ??
      stringValue(row.filename) ??
      stringValue(row.guid) ??
      stringValue(row.id);
    if (!id) continue;
    const mime = stringValue(row.mime_type) ?? stringValue(row.mimeType);
    const kind = mime?.startsWith("image/")
      ? "image"
      : mime?.startsWith("audio/")
        ? "audio"
        : mime?.startsWith("video/")
          ? "video"
          : "file";
    const size = numeric(row.size);
    found.push({
      kind,
      id,
      ...(mime ? { mimeType: mime } : {}),
      ...(size !== undefined ? { size } : {}),
    });
  }
  return found;
}

function createNodeImsgRunner(): ImsgCliRunner {
  return {
    watch({ cliPath, args, signal, onLine, onDiagnostic }) {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(cliPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const lines = createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
          terminal: false,
        });
        const errors = createInterface({
          input: child.stderr,
          crlfDelay: Infinity,
          terminal: false,
        });
        let bytes = 0;
        lines.on("line", (line) => {
          bytes += Buffer.byteLength(line);
          if (bytes <= MAX_OUTPUT_BYTES) onLine(line);
          else onDiagnostic("imsg watch output exceeded 1MB");
        });
        errors.on("line", onDiagnostic);
        const stop = () => child.kill("SIGTERM");
        signal.addEventListener("abort", stop, { once: true });
        child.once("error", (error) => {
          signal.removeEventListener("abort", stop);
          reject(error);
        });
        child.once("close", (code, exitSignal) => {
          signal.removeEventListener("abort", stop);
          lines.close();
          errors.close();
          if (signal.aborted) resolve();
          else
            reject(
              new Error(
                `imsg watch exited (${code ?? exitSignal ?? "unknown"})`
              )
            );
        });
      });
    },
    send({ cliPath, args, signal }) {
      return new Promise((resolve, reject) => {
        const child = spawn(cliPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          ...(signal.aborted ? {} : {}),
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => {
          if (total(stdout) < MAX_OUTPUT_BYTES) stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (total(stderr) < MAX_OUTPUT_BYTES) stderr.push(chunk);
        });
        const stop = () => child.kill("SIGTERM");
        signal.addEventListener("abort", stop, { once: true });
        child.once("error", (error) => {
          signal.removeEventListener("abort", stop);
          reject(error);
        });
        child.once("close", (code) => {
          signal.removeEventListener("abort", stop);
          resolve({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
    },
  };
}

function total(chunks: readonly Buffer[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
}

function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Human diagnostics may share stdout; the last JSON status wins.
    }
  }
  return undefined;
}

function parseCursor(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function safeFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = basename(value).replace(/[\u0000-\u001f\u007f]/g, "");
  return name ? name.slice(0, 120) : undefined;
}

function fileForMediaType(mediaType: string): string {
  if (mediaType === "image/png") return "image.png";
  if (mediaType === "image/jpeg") return "image.jpg";
  if (mediaType === "image/gif") return "image.gif";
  if (mediaType === "image/webp") return "image.webp";
  if (mediaType === "application/pdf") return "file.pdf";
  return "file.bin";
}

function mediaTypeForFile(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
