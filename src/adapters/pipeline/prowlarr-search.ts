import { ProviderError } from "../../agent/capabilities/containers.ts";
import type {
  ReleaseCandidate,
  ReleaseSearchProvider,
} from "../../agent/capabilities/pipeline.ts";

const CATEGORY: Record<string, string> = {
  movie: "2000",
  tv: "5000",
  music: "3000",
};

export class ProwlarrSearchProvider implements ReleaseSearchProvider {
  readonly service = "prowlarr";
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      fetch?: typeof fetch;
    }
  ) {
    this.base = options.baseUrl.trim().replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async search(input: {
    query: string;
    type?: "movie" | "tv" | "music" | "any";
    limit?: number;
  }): Promise<ReleaseCandidate[]> {
    const query = input.query.trim();
    if (!query || query.length > 200)
      throw new ProviderError("UNKNOWN", "query must be 1-200 characters");
    const params = new URLSearchParams({ query, type: "search", limit: "100" });
    const category = CATEGORY[input.type ?? "any"];
    if (category) params.set("categories", category);
    const response = await this.fetchImpl(
      `${this.base}/api/v1/search?${params}`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
        headers: {
          "X-Api-Key": this.options.apiKey,
          Accept: "application/json",
        },
      }
    );
    if (response.status === 401 || response.status === 403)
      throw new ProviderError("UNAUTHORIZED", "Prowlarr rejected the API key");
    if (!response.ok)
      throw new ProviderError(
        "UNKNOWN",
        `Prowlarr search failed (${response.status})`
      );
    const rows: unknown = await response.json();
    if (!Array.isArray(rows))
      throw new ProviderError("UNKNOWN", "Prowlarr returned an invalid result");
    return rank(
      rows.flatMap((row) => {
        const item = toCandidate(row);
        return item ? [item] : [];
      })
    ).slice(0, Math.min(Math.max(input.limit ?? 10, 1), 30));
  }
}

function toCandidate(value: unknown): ReleaseCandidate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const url = [row.magnetUrl, row.downloadUrl].find(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      /^(magnet:\?|https?:\/\/)/i.test(candidate)
  );
  const title =
    typeof row.title === "string" ? row.title.slice(0, 300) : undefined;
  if (!url || !title) return undefined;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  return {
    title,
    indexer: typeof row.indexer === "string" ? row.indexer : undefined,
    sizeBytes: num(row.size),
    seeders: num(row.seeders),
    leechers: num(row.leechers),
    publishedAt:
      typeof row.publishDate === "string" ? row.publishDate : undefined,
    downloadUrl: url,
    infoUrl:
      typeof row.infoUrl === "string" && /^https?:\/\//i.test(row.infoUrl)
        ? row.infoUrl
        : undefined,
    quality: parseQuality(title),
  };
}

export function parseQuality(title: string): string | undefined {
  const parts = [
    /2160p|4k|uhd/i.exec(title)?.[0] && "2160p",
    !/2160p|4k|uhd/i.test(title)
      ? /1080p|720p|480p/i.exec(title)?.[0]?.toLowerCase()
      : undefined,
    /remux/i.test(title)
      ? "Remux"
      : /blu-?ray|bdrip/i.test(title)
        ? "BluRay"
        : /web-?dl|webrip/i.test(title)
          ? "WEB"
          : undefined,
    /hdr10\+?|dolby ?vision|\bdv\b/i.exec(title)?.[0] ? "HDR" : undefined,
    /flac|lossless/i.test(title) ? "FLAC" : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

/** Healthy swarms first; releases nobody seeds sink to the bottom. */
function rank(items: ReleaseCandidate[]): ReleaseCandidate[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = item.title.toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0));
}

export function createProwlarrSearchProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): ProwlarrSearchProvider | undefined {
  const pick = (...values: Array<string | undefined>) =>
    values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
  const baseUrl = pick(env.THEBE_PROWLARR_URL, env.PROWLARR_URL);
  const apiKey = pick(env.THEBE_PROWLARR_API_KEY, env.PROWLARR_API_KEY);
  return baseUrl && apiKey
    ? new ProwlarrSearchProvider({ baseUrl, apiKey })
    : undefined;
}
