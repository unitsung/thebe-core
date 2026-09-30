import { ProviderError } from "../../agent/capabilities/containers.ts";
import {
  mapMediaItemDetail,
  mapMediaItems,
  mapMediaLibraries,
  mapMediaSearch,
  mapMediaSessions,
  mediaItemPathSegment,
  mediaLibrarySearchQuery,
  type MediaItem,
  type MediaItemDetail,
  type MediaLibrary,
  type MediaLibraryProvider,
  type MediaSearchPage,
  type MediaSearchQuery,
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

  async searchItems(query: MediaSearchQuery): Promise<MediaSearchPage> {
    const body = await this.requestJson(
      `/emby/Users/${this.userId}/Items?${mediaLibrarySearchQuery(query, "emby")}`,
    );
    return mapMediaSearch(body);
  }

  async getItem(id: string): Promise<MediaItemDetail | undefined> {
    try {
      const body = await this.requestJson(
        `/emby/Users/${this.userId}/Items/${mediaItemPathSegment(id)}`,
      );
      return mapMediaItemDetail(body);
    } catch (error) {
      if (error instanceof ProviderError && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
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
          : response.status === 404
            ? "NOT_FOUND"
            : "UNKNOWN",
        `Emby HTTP ${response.status}`,
      );
    }
    return (await response.json()) as Json | unknown[];
  }
}
