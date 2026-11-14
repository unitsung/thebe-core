import { execFile } from "node:child_process";
import type {
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import {
  addressValue,
  networkFailure,
  postJson,
  responseDetail,
  retryAfter,
  truncate,
} from "./shared.ts";

const MAX_TEXT = 39_000;

export type OpenClawRunResult = {
  code: number;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Set when the executable itself could not be started (ENOENT, EACCES). */
  spawnError?: string;
};

export type OpenClawRunner = (
  args: readonly string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv }
) => Promise<OpenClawRunResult>;

export type OpenClawGateway = {
  /** Gateway HTTP origin, for example `http://openclaw:18789`. */
  url: string;
  /** Bearer token from `OPENCLAW_GATEWAY_TOKEN`. */
  token?: string;
  /** Gateway session whose tool policy is used; omitted means the main session. */
  sessionKey?: string;
};

/**
 * Bridges to OpenClaw so one adapter reaches every channel OpenClaw supports (Telegram, Slack,
 * Discord, WhatsApp, Signal, Matrix, Teams, Google Chat, iMessage, ...).
 *
 * Core owns the outbox, retries, quiet hours and content. OpenClaw only performs the native send.
 * Two transports are supported:
 *
 * - `gateway`: `POST /tools/invoke` with the `message` tool. This is the deployment shape: Core
 *   stays a client and the OpenClaw Gateway runs as a sidecar.
 * - `bin`: `openclaw message send ... --json`. This is for local development where the CLI is
 *   installed on the same host.
 *
 * A missing CLI, an invalid gateway URL or an unconfigured channel is a permanent configuration
 * error; a timeout is `unknown` because the message may already have reached the platform.
 */
export function createOpenClawNotificationAdapter(
  options: {
    bin?: string;
    run?: OpenClawRunner;
    gateway?: OpenClawGateway;
    fetch?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): NotificationAdapter {
  const gatewayUrl = options.gateway?.url.trim();
  const gateway = gatewayUrl
    ? {
        endpoint: toolsInvokeUrl(gatewayUrl),
        token: options.gateway?.token?.trim(),
        sessionKey: options.gateway?.sessionKey?.trim(),
      }
    : undefined;
  const bin = options.bin?.trim() || "openclaw";
  const run = options.run ?? defaultRunner(bin);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: "openclaw",
    capabilities: { proactive: true, markdown: true, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return targetOf(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const target = targetOf(input.target.channel.address);
      if (!target) {
        return { status: "discard", reason: "openclaw_target_missing" };
      }
      const text = truncate(render(input), MAX_TEXT);
      if (!text) return { status: "discard", reason: "empty_notice" };
      if (gateway) {
        return sendViaGateway({
          input,
          target,
          text,
          endpoint: gateway.endpoint,
          token: gateway.token,
          sessionKey: gateway.sessionKey,
          fetch: fetchImpl,
          timeoutMs,
        });
      }
      return sendViaCli({
        input,
        target,
        text,
        run,
        timeoutMs,
        env: options.env ?? process.env,
      });
    },
  };
}

async function sendViaGateway(params: {
  input: NotificationSendInput;
  target: OpenClawTarget;
  text: string;
  endpoint: string | undefined;
  token: string | undefined;
  sessionKey: string | undefined;
  fetch: typeof fetch;
  timeoutMs: number;
}): Promise<NotificationDeliveryAttempt> {
  if (!params.endpoint) {
    return { status: "discard", reason: "openclaw_gateway_url_invalid" };
  }
  const { target } = params;
  const result = await postJson(
    params.fetch,
    params.endpoint,
    {
      tool: "message",
      action: "send",
      args: {
        channel: target.channel,
        target: target.target,
        message: params.text,
        ...(target.account ? { accountId: target.account } : {}),
        ...(target.threadId ? { threadId: target.threadId } : {}),
        ...(target.replyTo ? { replyTo: target.replyTo } : {}),
        ...(target.silent ? { silent: true } : {}),
      },
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      idempotencyKey: params.input.idempotencyKey,
    },
    {
      timeoutMs: params.timeoutMs,
      headers: params.token ? { authorization: `Bearer ${params.token}` } : {},
    }
  );
  return classifyGateway(result);
}

async function sendViaCli(params: {
  input: NotificationSendInput;
  target: OpenClawTarget;
  text: string;
  run: OpenClawRunner;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<NotificationDeliveryAttempt> {
  const { target } = params;
  const args = [
    "message",
    "send",
    "--channel",
    target.channel,
    "--target",
    target.target,
    "--message",
    params.text,
    "--json",
  ];
  if (target.account) args.push("--account", target.account);
  if (target.threadId) args.push("--thread-id", target.threadId);
  if (target.replyTo) args.push("--reply-to", target.replyTo);
  if (target.silent) args.push("--silent");

  let result: OpenClawRunResult;
  try {
    result = await params.run(args, {
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
  } catch (error) {
    return {
      status: "retry",
      reason: `openclaw failed: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 300),
    };
  }
  return classifyCli(result);
}

function toolsInvokeUrl(base: string): string | undefined {
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    if (path.endsWith("/tools/invoke")) {
      url.pathname = path;
    } else {
      url.pathname = `${path}/tools/invoke`;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

const CHANNEL = /^[a-z][a-z0-9_-]{0,31}$/;
const TARGET_MAX = 512;

type OpenClawTarget = {
  channel: string;
  target: string;
  account?: string;
  threadId?: string;
  replyTo?: string;
  silent?: boolean;
};

function targetOf(
  address: Record<string, string> | undefined
): OpenClawTarget | undefined {
  const channel = addressValue(address, "channel");
  const target = addressValue(address, "target");
  if (!channel || !CHANNEL.test(channel)) return undefined;
  if (!target || target.length > TARGET_MAX) return undefined;
  const account = addressValue(address, "account");
  const threadId = addressValue(address, "threadId");
  const replyTo = addressValue(address, "replyTo");
  return {
    channel,
    target,
    ...(account ? { account } : {}),
    ...(threadId ? { threadId } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(addressValue(address, "silent") === "true" ? { silent: true } : {}),
  };
}

function render(input: NotificationSendInput): string {
  const lines = [input.notification.title, input.notification.body];
  if (input.notification.deepLink) lines.push(input.notification.deepLink);
  return lines.join("\n\n");
}

function classifyCli(result: OpenClawRunResult): NotificationDeliveryAttempt {
  const parsed = parseJson(result.stdout);
  const delivery = deliveryStatus(parsed);
  if (delivery === "sent") return { status: "sent" };
  if (delivery === "suppressed") {
    return { status: "discard", reason: "openclaw_suppressed" };
  }
  if (delivery === "partial_failed") {
    return {
      status: "unknown",
      reason: "openclaw partial delivery: a later payload failed",
    };
  }
  if (result.spawnError) {
    return {
      status: "discard",
      reason: `openclaw unavailable: ${result.spawnError}`,
    };
  }
  if (result.timedOut || result.signal === "SIGTERM") {
    return { status: "unknown", reason: "openclaw send timed out" };
  }
  if (result.code === 0) return { status: "sent" };

  const reason = errorText(parsed, result.stderr, result.stdout);
  if (/rate.?limit|too many requests|\b429\b|try again/i.test(reason)) {
    return {
      status: "retry",
      reason: reason.slice(0, 300),
      retryAfterMs: 60_000,
    };
  }
  if (
    /unknown_channel|invalid_delivery_target|no_delivery_target|not configured|not found|no such|missing|invalid target/i.test(
      reason
    )
  ) {
    return { status: "discard", reason: reason.slice(0, 300) };
  }
  return {
    status: "retry",
    reason: reason.slice(0, 300) || "openclaw send failed",
  };
}

function classifyGateway(
  result: Awaited<ReturnType<typeof postJson>>
): NotificationDeliveryAttempt {
  if (result.kind === "error") return networkFailure(result.error);
  const status = result.response.status;
  const detail = responseDetail(result.body, result.text);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 408 || status === 425 || status === 429) {
    return {
      status: "retry",
      reason: `openclaw_gateway_busy (${status})${suffix}`,
      ...retryAfter(result.response),
    };
  }
  if (status >= 500) {
    return {
      status: "retry",
      reason: `openclaw_gateway_unavailable (${status})${suffix}`,
      ...retryAfter(result.response),
    };
  }
  if (status >= 400) {
    return {
      status: "discard",
      reason: `openclaw_gateway_refused (${status})${suffix}`,
    };
  }
  if (status < 200 || status >= 300) {
    return {
      status: "discard",
      reason: `openclaw_gateway_unexpected_status (${status})${suffix}`,
    };
  }

  const body = result.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const row = body as Record<string, unknown>;
    const fact = findDeliveryFact(row.result) ?? findDeliveryFact(row);
    if (fact) {
      if (fact.status === "settled" || fact.status === "sent") {
        return fact.partial
          ? { status: "unknown", reason: "openclaw partial delivery" }
          : { status: "sent" };
      }
      if (fact.status === "suppressed") {
        return { status: "discard", reason: "openclaw_suppressed" };
      }
      if (fact.status === "dryRun") {
        return { status: "discard", reason: "openclaw_dry_run" };
      }
      // failed (or unrecognised status): the tool reported a definite
      // non-delivery, so replaying cannot duplicate a delivered message.
      return { status: "retry", reason: "openclaw delivery failed" };
    }
    const innerStatus = findStatus(row.result);
    if (innerStatus === "suppressed") {
      return { status: "discard", reason: "openclaw_suppressed" };
    }
    if (innerStatus === "dryRun") {
      return { status: "discard", reason: "openclaw_dry_run" };
    }
    if (
      row.ok === false ||
      innerStatus === "failed" ||
      innerStatus === "error" ||
      findFailureSignal(row.result)
    ) {
      // Gateway accepted the call but the tool/payload reports a definite
      // failure (plugin send ok:false, error object, ...). Nothing landed,
      // so it is safe to replay.
      return { status: "retry", reason: `openclaw delivery failed${suffix}` };
    }
  }
  // A 2xx without a delivery receipt is indeterminate: the request reached
  // the Gateway and may already be on the platform. Never claim success
  // (that would silently drop a failed notice) and never replay (that would
  // duplicate a delivered one). `unknown` is finished-but-unconfirmed and
  // the outbox never replays it.
  return { status: "unknown", reason: "openclaw delivery unconfirmed" };
}

function findDeliveryFact(
  value: unknown,
  depth = 0
): { status: string; partial: boolean } | undefined {
  if (
    depth > 4 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const fact = row.messageDelivery;
  if (fact && typeof fact === "object" && !Array.isArray(fact)) {
    const status = (fact as Record<string, unknown>).status;
    if (typeof status === "string") {
      return {
        status,
        partial: (fact as Record<string, unknown>).partialDelivery === true,
      };
    }
  }
  for (const key of [
    "result",
    "details",
    "payload",
    "sendResult",
    "toolResult",
  ]) {
    const nested = findDeliveryFact(row[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function findStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.status === "string") return row.status;
  for (const key of ["result", "details", "payload"]) {
    const nested = findStatus(row[key]);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * A 2xx tool result can wrap a definite failure instead of a delivery fact
 * (e.g. a plugin send returning `{ok:false, error:{message:...}}`). Detect it
 * so we retry rather than record a false success. Nested only through known
 * tool-result envelopes to avoid treating arbitrary text inside a message as
 * an error.
 */
function findFailureSignal(value: unknown, depth = 0): boolean {
  if (
    depth > 4 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const row = value as Record<string, unknown>;
  if (row.ok === false) return true;
  const nestedError = row.error;
  if (nestedError && typeof nestedError === "object") return true;
  if (typeof nestedError === "string" && nestedError.trim()) return true;
  const status = row.status;
  if (status === "failed" || status === "error") return true;
  for (const key of [
    "result",
    "details",
    "payload",
    "sendResult",
    "toolResult",
  ]) {
    if (findFailureSignal(row[key], depth + 1)) return true;
  }
  return false;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function deliveryStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const direct = row.deliveryStatus;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const status = (direct as Record<string, unknown>).status;
    if (typeof status === "string") return status;
  }
  const result = row.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return deliveryStatus(result);
  }
  return undefined;
}

function errorText(parsed: unknown, stderr: string, stdout: string): string {
  const fromBody = findError(parsed);
  return (fromBody || stderr || stdout || "openclaw send failed").trim();
}

function findError(value: unknown, depth = 0): string | undefined {
  if (
    depth > 3 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  for (const key of ["errorMessage", "message", "reason", "error"]) {
    const item = row[key];
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = findError(item, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}

function defaultRunner(bin: string): OpenClawRunner {
  return (args, options) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        {
          timeout: options.timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          ...(options.env ? { env: options.env } : {}),
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0;
          const spawnError =
            error && typeof error.code === "string" ? error.code : undefined;
          const timedOut = Boolean(
            error && (error as unknown as { killed?: boolean }).killed === true
          );
          resolve({
            code,
            signal: error?.signal ?? null,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            ...(timedOut ? { timedOut } : {}),
            ...(spawnError ? { spawnError } : {}),
          });
        }
      );
    });
}
