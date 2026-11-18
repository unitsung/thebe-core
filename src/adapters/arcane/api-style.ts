export type ArcaneApiStyle = "legacy" | "agents";

/**
 * Arcane 3.0 moved every `/api/environments` route to `/api/agents` and
 * replaced action subpaths with `?action=` query parameters. 1.x and 2.x only
 * expose the legacy shape, so adapters resolve this once per connection.
 */
export function arcaneApiStyleFromVersion(
  value: string | undefined
): ArcaneApiStyle | undefined {
  if (!value) return undefined;
  const match = /^v?(\d+)/i.exec(value.trim());
  if (!match) return undefined;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return undefined;
  return major >= 3 ? "agents" : "legacy";
}

export async function detectArcaneApiStyle(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<ArcaneApiStyle | undefined> {
  const { baseUrl, apiKey, fetchImpl } = options;

  // Public on 1.20+, 2.x and 3.x; the cheapest reliable signal.
  try {
    const response = await fetchImpl(`${baseUrl}/api/version`, {
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;
      const version =
        typeof body?.currentVersion === "string"
          ? body.currentVersion
          : typeof body?.displayVersion === "string"
            ? body.displayVersion
            : undefined;
      const style = arcaneApiStyleFromVersion(version);
      if (style) return style;
    }
  } catch {
    // Fall through to the route probe.
  }

  // Older or proxied builds may not answer /api/version. `/api/agents` exists
  // only on 3.x, so a 404 there means the legacy route shape.
  try {
    const response = await fetchImpl(`${baseUrl}/api/agents?limit=1&start=0`, {
      headers: {
        Accept: "application/json",
        "X-Api-Key": apiKey,
      },
    });
    if (response.status === 404) return "legacy";
    // 401/403 means the v3-only route exists; other statuses are not evidence
    // either way.
    if (response.ok || response.status === 401 || response.status === 403) {
      return "agents";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function environmentsPath(style: ArcaneApiStyle): string {
  return style === "agents" ? "/api/agents" : "/api/environments";
}

export function environmentPath(
  style: ArcaneApiStyle,
  environmentId: string
): string {
  return `${environmentsPath(style)}/${encodeURIComponent(environmentId)}`;
}

export function containerActionPath(
  style: ArcaneApiStyle,
  environmentId: string,
  containerId: string,
  action: string
): string {
  const base = `${environmentPath(style, environmentId)}/containers/${encodeURIComponent(containerId)}`;
  return style === "agents"
    ? `${base}?action=${encodeURIComponent(action)}`
    : `${base}/${encodeURIComponent(action)}`;
}

export function containerLogsWSPath(
  style: ArcaneApiStyle,
  environmentId: string,
  containerId: string,
  query: string
): string {
  return `${environmentPath(style, environmentId)}/ws/containers/${encodeURIComponent(containerId)}/logs?${query}`;
}

export function activitiesPath(
  style: ArcaneApiStyle,
  environmentId: string
): string {
  return `${environmentPath(style, environmentId)}/activities`;
}

export function activityCancelPath(
  style: ArcaneApiStyle,
  environmentId: string,
  activityId: string
): string {
  const base = `${activitiesPath(style, environmentId)}/${encodeURIComponent(activityId)}`;
  return style === "agents" ? `${base}?action=cancel` : `${base}/cancel`;
}
