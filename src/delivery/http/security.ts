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
 * DNS-rebound Host cannot pass just because Origin matches it. Loopback,
 * private-network addresses, `.local`, and Tailscale `.ts.net` names are
 * trusted without listing, so a homelab deployment does not have to enumerate
 * its own names; the shared token remains the primary guard.
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

  const host =
    request.headers.get("host") ??
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return null;
      }
    })();
  if (allowedHosts && allowedHosts.size > 0) {
    if (!host || !hostAllowed(host, allowedHosts)) {
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
        if (!allowedHosts || !hostAllowed(originUrl.host, allowedHosts)) {
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

/** Allowlist entry, or a name this host can be reached by on a local network. */
function hostAllowed(hostHeader: string, allowed: Set<string>): boolean {
  if (allowed.has("*")) {
    return true;
  }
  return hostInAllowlist(hostHeader, allowed) || isTrustedLocalHost(hostnameOf(hostHeader));
}

function isTrustedLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host.endsWith(".local") || host.endsWith(".ts.net")) {
    return true;
  }
  return isPrivateAddress(host);
}

function isPrivateAddress(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host);
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
