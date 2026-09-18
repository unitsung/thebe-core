import { ProviderError } from "../../agent/capabilities/containers.ts";
import {
  mapPhotoAlbums,
  mapPhotoAssets,
  mapPhotoStatistics,
  type PhotoAlbum,
  type PhotoAsset,
  type PhotoLibraryProvider,
  type PhotoStatistics,
} from "../../agent/capabilities/media.ts";

export type ImmichAdapterOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
};

type Json = Record<string, unknown>;

export class ImmichAdapter implements PhotoLibraryProvider {
  // Official: x-api-key header. Albums GET /api/albums, stats GET /api/assets/statistics,
  // assets POST /api/search/metadata (GET /api/assets is not a list).
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ImmichAdapterOptions) {
    this.baseUrl = withApiPrefix(options.baseUrl.replace(/\/$/, ""));
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listAssets(): Promise<PhotoAsset[]> {
    const body = await this.requestJson("/search/metadata", {
      method: "POST",
      body: { size: 20, order: "desc" },
    });
    return mapPhotoAssets(body);
  }

  async listAlbums(): Promise<PhotoAlbum[]> {
    const body = await this.requestJson("/albums");
    return mapPhotoAlbums(body);
  }

  async getStatistics(): Promise<PhotoStatistics> {
    const body = await this.requestJson("/assets/statistics");
    return mapPhotoStatistics(body);
  }

  private async requestJson(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Json | unknown[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (cause) {
      throw new ProviderError("UNREACHABLE", "Immich is unreachable", cause);
    }
    if (!response.ok) {
      throw new ProviderError(
        response.status === 401 || response.status === 403
          ? "UNAUTHORIZED"
          : "UNKNOWN",
        `Immich HTTP ${response.status}`,
      );
    }
    return (await response.json()) as Json | unknown[];
  }
}

function withApiPrefix(baseUrl: string): string {
  return baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
}
