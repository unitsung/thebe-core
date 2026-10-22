import type {
  MusicResearchProvider,
  MusicResearchQuery,
} from "../../agent/capabilities/music-research.ts";
export function createMusicResearchProvider(
  request: typeof fetch = fetch
): MusicResearchProvider {
  let nextRequest = 0;
  return {
    async research({
      query,
      entity = "recording",
      language = "zh",
    }: MusicResearchQuery) {
      const delay = Math.max(0, nextRequest - Date.now());
      nextRequest = Math.max(Date.now(), nextRequest) + 1_000;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const music = new URL(`https://musicbrainz.org/ws/2/${entity}/`);
      music.search = new URLSearchParams({
        query,
        fmt: "json",
        limit: "3",
      }).toString();
      const wiki = new URL(`https://${language}.wikipedia.org/w/api.php`);
      wiki.search = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: query,
        gsrlimit: "2",
        prop: "extracts|info",
        inprop: "url",
        exintro: "1",
        explaintext: "1",
        exchars: "900",
        format: "json",
      }).toString();
      const sources: Record<string, unknown>[] = [],
        source_errors: string[] = [];
      for (const [provider, url] of [
        ["MusicBrainz", music],
        ["Wikipedia", wiki],
      ] as const) {
        try {
          const response = await request(url, {
            headers: {
              "User-Agent":
                "Thebe/1.0 (https://github.com/unitsung/thebe-core)",
            },
            signal: AbortSignal.timeout(18_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          if (text.length > 2_000_000)
            throw new Error("response exceeds size limit");
          const data = JSON.parse(text);
          if (!data || typeof data !== "object" || data.error)
            throw new Error("invalid source response");
          if (provider === "MusicBrainz") {
            const rows = data[`${entity}s`];
            for (const row of Array.isArray(rows) ? rows.slice(0, 3) : []) {
              if (!row || typeof row !== "object") continue;
              const item = Object.fromEntries(
                Object.entries(row).filter(([key]) =>
                  [
                    "id",
                    "title",
                    "name",
                    "score",
                    "disambiguation",
                    "country",
                    "date",
                    "first-release-date",
                    "artist-credit",
                    "life-span",
                    "tags",
                  ].includes(key)
                )
              );
              if (Array.isArray(row.releases))
                item.releases = row.releases
                  .slice(0, 3)
                  .map((release: Record<string, unknown>) =>
                    Object.fromEntries(
                      Object.entries(release).filter(([key]) =>
                        ["id", "title", "date", "country"].includes(key)
                      )
                    )
                  );
              if (typeof row.id === "string")
                item.url = `https://musicbrainz.org/${entity}/${encodeURIComponent(row.id)}`;
              sources.push({ ...item, provider });
            }
          } else {
            for (const page of Object.values(data.query?.pages ?? {}).slice(
              0,
              2
            ) as Record<string, unknown>[])
              sources.push({
                provider,
                title: page.title ?? "",
                text: page.extract ?? "",
                url: page.fullurl ?? "",
              });
          }
        } catch (error) {
          source_errors.push(
            `${provider}: ${error instanceof Error ? error.message : "source unavailable"}`
          );
        }
      }
      return {
        query,
        sources,
        source_errors,
        note: "Candidates may refer to different artists or versions. Verify identity and cite links; missing evidence is not verification.",
      };
    },
  };
}
