import { ProviderError } from "../../agent/capabilities/containers.ts";
import {
  mapMediaItems,
  mapMediaLibraries,
  mapMediaSessions,
  type MediaItem,
  type MediaLibrary,
  type MediaLibraryProvider,
  type MediaSession,
} from "../../agent/capabilities/media.ts";

export type JellyfinAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  userId: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

function cleanBaseUrl(raw: string): string {
  let value = raw.trim().replace(/\/+$/, "");
  for (const suffix of ["/api/v2.0", "/api/v2", "/api"]) {
    if (value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value.replace(/\/+$/, "");
}

export class JellyfinAdapter implements MediaLibraryProvider {
  // Official: Authorization: MediaBrowser Token="…". No /emby prefix (removed in 12.0).
  // Same MediaBrowser JSON as Emby for Views, Items/Latest, Sessions.
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JellyfinAdapterOptions) {
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listLibraries(): Promise<MediaLibrary[]> {
    const body = await this.requestJson(`/Users/${this.userId}/Views`);
    return mapMediaLibraries(body);
  }

  async listRecent(): Promise<MediaItem[]> {
    const body = await this.requestJson(
      `/Users/${this.userId}/Items/Latest?Limit=20`,
    );
    return mapMediaItems(body);
  }

  async listSessions(): Promise<MediaSession[]> {
    const body = await this.requestJson("/Sessions");
    return mapMediaSessions(body);
  }

  private async requestJson(path: string): Promise<Json | unknown[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `MediaBrowser Token="${this.apiKey}"`,
        },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "Jellyfin is unreachable", cause);
    }
    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403
          ? "UNAUTHORIZED"
          : "UNKNOWN",
        `Jellyfin HTTP ${response.status}`,
      );
    }
    return (await response.json()) as Json | unknown[];
  }
}
