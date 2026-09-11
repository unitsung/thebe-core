/**
 * Cross-site checks for mutating requests.
 *
 * GET/HEAD skip this module on purpose: application-level token auth in
 * handler.ts is the primary guard for read routes. This file only does
 * browser cross-site / DNS-rebinding protection for writes.
 *
 * Non-browser clients (curl, iOS, Tauri) do not send Origin — origin
 * validation is skipped when Origin is absent. Browser cross-site
 * requests are blocked via sec-fetch-site first, then Origin vs Host.
 *
 * When allowedHosts is set, the Host header must be in that set so a
 * DNS-rebound Host cannot pass just because Origin matches it.
 */
export function validateRequestSecurity(
  request: Request,
  allowedHosts?: Set<string>,
): { ok: boolean; reason?: string } {
  const method = request.method.toUpperCase();
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!isMutating) {
    return { ok: true };
  }

  const host = request.headers.get("host");
  if (allowedHosts && allowedHosts.size > 0) {
    if (!host || !hostInAllowlist(host, allowedHosts)) {
      return { ok: false, reason: "host not allowed" };
    }
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return { ok: false, reason: "cross-site browser requests rejected" };
  }

  const origin = request.headers.get("origin");
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        if (!allowedHosts || !hostInAllowlist(originUrl.host, allowedHosts)) {
          return { ok: false, reason: "cross-origin browser requests rejected" };
        }
      }
    } catch {
      return { ok: false, reason: "invalid origin header" };
    }
  }

  return { ok: true };
}

function hostInAllowlist(hostHeader: string, allowed: Set<string>): boolean {
  const hostname = hostnameOf(hostHeader);
  if (allowed.has(hostHeader) || allowed.has(hostname)) {
    return true;
  }
  for (const entry of allowed) {
    if (hostnameOf(entry) === hostname) {
      return true;
    }
  }
  return false;
}

function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && trimmed.indexOf(":") === colon) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}
