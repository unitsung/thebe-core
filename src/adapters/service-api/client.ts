import type { ServiceAPIProvider } from "../../agent/capabilities/service-api.ts";
import { OpenAPIService, openAPIConnectionsFromEnv } from "./openapi.ts";

/** Existing deployment variables remain connection shortcuts, not API catalogs. */
export function createServiceAPIProvidersFromEnv(env: Record<string, string | undefined> = process.env): ServiceAPIProvider[] {
  const providers = new Map(openAPIConnectionsFromEnv(env).map(provider => [provider.id, provider]));
  for (const service of ["openlist", "cloudsaver"]) {
    if (providers.has(service)) continue;
    const key = service.toUpperCase();
    const baseURL = env[`THEBE_${key}_BASE_URL`]?.trim() || env[`${key}_BASE_URL`]?.trim();
    const token = env[`THEBE_${key}_TOKEN`]?.trim() || env[`${key}_TOKEN`]?.trim();
    if (baseURL && token) providers.set(service, new OpenAPIService({ id: service, baseURL,
      headers: { Authorization: service === "cloudsaver" ? `Bearer ${token}` : token } }));
  }
  return [...providers.values()];
}
