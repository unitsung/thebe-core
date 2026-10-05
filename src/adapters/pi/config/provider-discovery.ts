import type { RuntimeProviderConfiguration } from "../../../agent/runtime/interface.ts";

/** Discovery uses the configured service origin, never a shared catalogue. */
export async function discoverProviderModels(
  configuration: RuntimeProviderConfiguration,
  auth: { apiKey?: string; headers?: Record<string, string> },
  request: typeof fetch = fetch,
): Promise<RuntimeProviderConfiguration["models"]> {
  const base = configuration.baseUrl.replace(/\/+$/, "");
  const isClinePass = new URL(base).hostname === "api.cline.bot" && configuration.models.some(model => model.id.startsWith("cline-pass/"));
  const candidates = isClinePass ? [`${base}/ai/cline/recommended-models`] : base.endsWith("/v1") || configuration.api === "google-generative-ai"
    ? [`${base}/models`]
    : configuration.api === "anthropic-messages"
      ? [`${base}/v1/models`, `${base}/models`]
      : [`${base}/models`, `${base}/v1/models`];
  const headers: Record<string, string> = { Accept: "application/json", ...auth.headers };
  if (auth.apiKey) {
    if (configuration.api === "anthropic-messages") {
      headers["x-api-key"] = auth.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (configuration.api === "google-generative-ai") headers["x-goog-api-key"] = auth.apiKey;
    else headers.Authorization = `Bearer ${auth.apiKey}`;
  }
  for (const [index, endpoint] of candidates.entries()) {
    const response = await request(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      if ((response.status === 404 || response.status === 405) && index < candidates.length - 1) continue;
      // Service bodies can echo credentials. Keep the error deliberately bounded.
      throw new Error(`Model discovery failed: HTTP ${response.status}`);
    }
    const payload = await response.json();
    const object = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const rows = isClinePass ? (Array.isArray(object.clinePass) ? [...object.clinePass, ...(Array.isArray(object.free) ? object.free : [])] : undefined)
      : Array.isArray(payload) ? payload : object.data ?? object.models;
    if (!Array.isArray(rows)) throw new Error("Service returned an invalid model list");
    const seen = new Set<string>();
    return rows.flatMap((row: any) => {
      const raw = typeof row === "string" ? row : row?.id ?? row?.name ?? row?.model;
      if (typeof raw !== "string" || !raw.trim()) return [];
      const id = raw.trim().replace(/^models\//, "");
      if (seen.has(id)) return [];
      seen.add(id);
      const previous = configuration.models.find(model => model.id === id);
      return [{ ...previous, id, name: row.displayName ?? row.display_name ?? row.name ?? previous?.name ?? id }];
    });
  }
  throw new Error("Model discovery endpoint is unavailable");
}
