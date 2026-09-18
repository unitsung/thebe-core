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

export type EmbyAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  userId: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

export class EmbyAdapter implements MediaLibraryProvider {
  // Official REST: http[s]://host:port/emby/{apipath}
  // Auth: X-Emby-Token (or api_key query). Views, Items/Latest, Sessions.
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EmbyAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.userId = options.userId;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listLibraries(): Promise<MediaLibrary[]> {
    const body = await this.requestJson(`/emby/Users/${this.userId}/Views`);
    return mapMediaLibraries(body);
  }

  async listRecent(): Promise<MediaItem[]> {
    const body = await this.requestJson(
      `/emby/Users/${this.userId}/Items/Latest?Limit=20`,
    );
    return mapMediaItems(body);
  }

  async listSessions(): Promise<MediaSession[]> {
    const body = await this.requestJson("/emby/Sessions");
    return mapMediaSessions(body);
  }

  private async requestJson(path: string): Promise<Json | unknown[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Emby-Token": this.apiKey,
        },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "Emby is unreachable", cause);
    }
    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403
          ? "UNAUTHORIZED"
          : "UNKNOWN",
        `Emby HTTP ${response.status}`,
      );
    }
    return (await response.json()) as Json | unknown[];
  }
}
