export function validateRequestSecurity(
  request: Request,
  allowedHosts?: Set<string>,
): { ok: boolean; reason?: string } {
  const method = request.method.toUpperCase();
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!isMutating) {
    return { ok: true };
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") {
    return { ok: false, reason: "cross-site browser requests rejected" };
  }

  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        if (!allowedHosts || !allowedHosts.has(originUrl.host)) {
          return { ok: false, reason: "cross-origin browser requests rejected" };
        }
      }
    } catch {
      return { ok: false, reason: "invalid origin header" };
    }
  }

  return { ok: true };
}
