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

/**
 * Emby and Jellyfin speak the same MediaBrowser REST API: the same Views, Items/Latest, Sessions and Items
 * calls with the same JSON. They differ only in the path prefix and in how the key is sent, so there is one
 * adapter and these two rows.
 */
export const MEDIA_BROWSER_FLAVORS = {
  emby: {
    label: "Emby",
    /** Official REST: http[s]://host:port/emby/{apipath}. */
    pathPrefix: "/emby",
    authHeaders: (apiKey: string) => ({ "X-Emby-Token": apiKey }),
  },
  jellyfin: {
    label: "Jellyfin",
    /** No /emby prefix (removed in 12.0). */
    pathPrefix: "",
    authHeaders: (apiKey: string) => ({
      Authorization: `MediaBrowser Token="${apiKey}"`,
    }),
  },
} as const;

export type MediaBrowserFlavor = keyof typeof MEDIA_BROWSER_FLAVORS;

export type MediaBrowserAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  userId: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

/** The server's own address, without a trailing slash or an API suffix someone pasted along with it. */
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

export class MediaBrowserAdapter implements MediaLibraryProvider {
  private readonly flavor: (typeof MEDIA_BROWSER_FLAVORS)[MediaBrowserFlavor];
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly flavorId: MediaBrowserFlavor,
    options: MediaBrowserAdapterOptions
  ) {
    this.flavor = MEDIA_BROWSER_FLAVORS[flavorId];
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
      `/Users/${this.userId}/Items/Latest?Limit=20`
    );
    return mapMediaItems(body);
  }

  async listSessions(): Promise<MediaSession[]> {
    const body = await this.requestJson("/Sessions");
    return mapMediaSessions(body);
  }

  async searchItems(query: MediaSearchQuery): Promise<MediaSearchPage> {
    const body = await this.requestJson(
      `/Users/${this.userId}/Items?${mediaLibrarySearchQuery(query, this.flavorId)}`
    );
    return mapMediaSearch(body);
  }

  async getItem(id: string): Promise<MediaItemDetail | undefined> {
    try {
      const body = await this.requestJson(
        `/Users/${this.userId}/Items/${mediaItemPathSegment(id)}`
      );
      return mapMediaItemDetail(body);
    } catch (error) {
      if (error instanceof ProviderError && error.code === "NOT_FOUND")
        return undefined;
      throw error;
    }
  }

  private async requestJson(path: string): Promise<Json | unknown[]> {
    const { label, pathPrefix, authHeaders } = this.flavor;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathPrefix}${path}`, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders(this.apiKey) },
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", `${label} is unreachable`, cause);
    }
    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403
          ? "UNAUTHORIZED"
          : response.status === 404
            ? "NOT_FOUND"
            : "UNKNOWN",
        `${label} HTTP ${response.status}`
      );
    }
    return (await response.json()) as Json | unknown[];
  }
}
