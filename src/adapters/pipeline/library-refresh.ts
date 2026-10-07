import { ProviderError } from "../../agent/capabilities/containers.ts";
import type { LibraryRefreshProvider } from "../../agent/capabilities/pipeline.ts";

/** Emby and Jellyfin share the library scan and item refresh endpoints. */
export class MediaServerRefreshProvider implements LibraryRefreshProvider {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(readonly service: "emby" | "jellyfin", private readonly options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async post(path: string): Promise<void> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "X-Emby-Token": this.options.apiKey, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) throw new ProviderError("UNAUTHORIZED", `${this.service} rejected the API key`);
    if (!response.ok) throw new ProviderError("UNKNOWN", `${this.service} request failed (${response.status})`);
  }

  scan(): Promise<void> {
    return this.post("/Library/Refresh");
  }

  refreshItem(input: { id: string; replaceAllMetadata?: boolean; replaceAllImages?: boolean }): Promise<void> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(input.id)) throw new ProviderError("UNKNOWN", "Invalid item id");
    const query = new URLSearchParams({
      Recursive: "true",
      MetadataRefreshMode: "FullRefresh",
      ImageRefreshMode: "FullRefresh",
      ReplaceAllMetadata: String(input.replaceAllMetadata === true),
      ReplaceAllImages: String(input.replaceAllImages === true),
    });
    return this.post(`/Items/${input.id}/Refresh?${query}`);
  }
}

export function createLibraryRefreshProvidersFromEnv(env: Record<string, string | undefined> = process.env): LibraryRefreshProvider[] {
  const pick = (...values: Array<string | undefined>) => values.map(value => value?.trim() ?? "").find(Boolean) ?? "";
  const providers: LibraryRefreshProvider[] = [];
  for (const service of ["emby", "jellyfin"] as const) {
    const key = service.toUpperCase();
    const baseUrl = pick(env[`THEBE_${key}_BASE_URL`], env[`${key}_BASE_URL`]);
    const apiKey = pick(env[`THEBE_${key}_API_KEY`], env[`${key}_API_KEY`]);
    if (baseUrl && apiKey) providers.push(new MediaServerRefreshProvider(service, { baseUrl, apiKey }));
  }
  return providers;
}
