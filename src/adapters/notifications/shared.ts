import type {
  NotificationDeliveryAttempt,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";

export type HttpResult =
  | { kind: "response"; response: Response; body: unknown; text: string }
  | { kind: "error"; error: unknown };

export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    method?: string;
  } = {}
): Promise<HttpResult> {
  try {
    const response = await fetchImpl(url, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { kind: "response", response, body: parsed, text };
  } catch (error) {
    return { kind: "error", error };
  }
}

export function classifyHttp(
  result: HttpResult,
  options: {
    detail?: string;
    /** Statuses that mean "try later" rather than "never". */
    retryStatuses?: readonly number[];
  } = {}
): NotificationDeliveryAttempt {
  if (result.kind === "error") {
    return networkFailure(result.error);
  }
  const status = result.response.status;
  if (status >= 200 && status < 300) return { status: "sent" };
  const detail = options.detail ?? responseDetail(result.body, result.text);
  const suffix = detail ? `: ${detail}` : "";
  if (status === 408 || status === 425 || status === 429) {
    return {
      status: "retry",
      reason: `provider_busy (${status})${suffix}`,
      ...retryAfter(result.response),
    };
  }
  if ((options.retryStatuses ?? []).includes(status) || status >= 500) {
    return {
      status: "retry",
      reason: `provider_unavailable (${status})${suffix}`,
      ...retryAfter(result.response),
    };
  }
  if (status >= 400) {
    return {
      status: "discard",
      reason: `provider_refused (${status})${suffix}`,
    };
  }
  return {
    status: "discard",
    reason: `unexpected_status (${status})${suffix}`,
  };
}

/** A request already on the wire that timed out may have reached the platform. */
export function networkFailure(error: unknown): NotificationDeliveryAttempt {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  const message =
    error instanceof Error ? error.message : String(error ?? "network error");
  if (name === "TimeoutError" || name === "AbortError") {
    return { status: "unknown", reason: `request timed out: ${message}` };
  }
  return { status: "retry", reason: `network error: ${message}` };
}

export function responseDetail(body: unknown, text: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const row = body as Record<string, unknown>;
    for (const key of ["error", "errmsg", "message", "description", "detail"]) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim().slice(0, 200);
      }
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        for (const nestedKey of ["message", "msg", "error"]) {
          if (typeof nested[nestedKey] === "string") {
            return String(nested[nestedKey]).trim().slice(0, 200);
          }
        }
      }
    }
  }
  return text.trim().slice(0, 200);
}

export function retryAfter(response: Response): { retryAfterMs?: number } {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return {};
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retryAfterMs: Math.min(seconds * 1_000, 5 * 60_000) };
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return {
      retryAfterMs: Math.min(Math.max(0, at - Date.now()), 5 * 60_000),
    };
  }
  return {};
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function addressValue(
  address: Record<string, string> | undefined,
  key: string
): string | undefined {
  const value = address?.[key]?.trim();
  return value || undefined;
}

/** The one text every channel sends: title, body, then the deep link when there is one. */
export function renderNotice(
  input: NotificationSendInput,
  options: { separator?: string; link?: boolean } = {}
): string {
  return [
    input.notification.title,
    input.notification.body,
    ...(options.link === false || !input.notification.deepLink
      ? []
      : [input.notification.deepLink]),
  ].join(options.separator ?? "\n\n");
}

/** An address may name a server; only an absolute HTTP(S) URL with no embedded credentials is one. */
export function httpUrl(
  value: string | undefined,
  options: { allowHttp?: boolean } = {}
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const allowsPlain = options.allowHttp !== false && url.protocol === "http:";
    if (url.protocol !== "https:" && !allowsPlain) return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  body: URLSearchParams,
  options: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    method?: string;
  } = {}
): Promise<HttpResult> {
  try {
    const response = await fetchImpl(url, {
      method: options.method ?? "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options.headers,
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { kind: "response", response, body: parsed, text };
  } catch (error) {
    return { kind: "error", error };
  }
}
