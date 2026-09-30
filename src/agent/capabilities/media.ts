export type MediaLibrary = {
  id: string;
  title: string;
  kind?: string;
};

export type MediaItem = {
  id: string;
  title: string;
  type?: string;
  year?: number;
};

export type MediaPerson = {
  id?: string;
  name: string;
  role?: string;
  type?: string;
};

/** Library record. Community rating is the media server's own value. */
export type MediaItemDetail = MediaItem & {
  overview?: string;
  genres?: string[];
  communityRating?: number;
  people?: MediaPerson[];
  providerIds?: Record<string, string>;
};

export type MediaSearchQuery = {
  query?: string;
  person?: string;
  year?: number;
  itemTypes?: string[];
  startIndex?: number;
  limit?: number;
};

export type MediaSearchPage = {
  items: MediaItemDetail[];
  total?: number;
};

export type MediaSession = {
  id: string;
  title: string;
  client?: string;
  userName?: string;
};

export type PhotoAsset = {
  id: string;
  title: string;
  type?: string;
};

export type PhotoAlbum = {
  id: string;
  title: string;
  assetCount?: number;
};

export type PhotoStatistics = {
  images: number;
  videos: number;
  total: number;
};

export interface MediaLibraryProvider {
  listLibraries(): Promise<MediaLibrary[]>;
  listRecent(): Promise<MediaItem[]>;
  listSessions(): Promise<MediaSession[]>;
  searchItems(query: MediaSearchQuery): Promise<MediaSearchPage>;
  getItem(id: string): Promise<MediaItemDetail | undefined>;
}

export interface PhotoLibraryProvider {
  listAssets(): Promise<PhotoAsset[]>;
  listAlbums(): Promise<PhotoAlbum[]>;
  getStatistics(): Promise<PhotoStatistics>;
  /** Machine-learning match. Failures stay visible; this is not filename search. */
  searchSemantic(query: string, options?: { size?: number; page?: number }): Promise<PhotoAsset[]>;
}

export const MEDIA_PROVIDER_IDS = {
  emby: "emby",
  jellyfin: "jellyfin",
  immich: "immich",
} as const;

export const EMBY_TOOL_NAMES = [
  "emby.libraries",
  "emby.recent",
  "emby.sessions",
] as const;

export const JELLYFIN_TOOL_NAMES = [
  "jellyfin.libraries",
  "jellyfin.recent",
  "jellyfin.sessions",
] as const;

export const IMMICH_TOOL_NAMES = [
  "immich.assets",
  "immich.albums",
  "immich.statistics",
] as const;

export const EMBY_LOOKUP_TOOL_NAMES = ["emby.search", "emby.item"] as const;
export const JELLYFIN_LOOKUP_TOOL_NAMES = ["jellyfin.search", "jellyfin.item"] as const;
export const IMMICH_SEARCH_TOOL_NAMES = ["immich.search"] as const;

export type EmbyLookupToolName = (typeof EMBY_LOOKUP_TOOL_NAMES)[number];
export type JellyfinLookupToolName = (typeof JELLYFIN_LOOKUP_TOOL_NAMES)[number];
export type ImmichSearchToolName = (typeof IMMICH_SEARCH_TOOL_NAMES)[number];
export type MediaLookupToolName =
  | EmbyLookupToolName
  | JellyfinLookupToolName
  | ImmichSearchToolName;

const MEDIA_ITEM_TYPES = ["Movie", "Series", "Episode"] as const;

export const MEDIA_LIBRARY_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Title or other library text" },
    person: { type: "string", description: "Cast or crew name" },
    year: { type: "integer", description: "Production year" },
    itemTypes: {
      type: "array",
      items: { type: "string", enum: [...MEDIA_ITEM_TYPES] },
      description: "Movie, Series, or Episode. Default Movie and Series.",
    },
    startIndex: { type: "integer", description: "Page offset, default 0" },
    limit: { type: "integer", description: "1-40, default 20" },
  },
} as const;

export const MEDIA_LIBRARY_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Verified library item id" },
  },
  required: ["id"],
} as const;

export const IMMICH_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "What is visible in the photo or video" },
    size: { type: "integer", description: "1-40, default 20" },
    page: { type: "integer", description: "Page number, default 1" },
  },
  required: ["query"],
} as const;

export const MEDIA_LOOKUP_SCHEMAS: Record<MediaLookupToolName, Record<string, unknown>> = {
  "emby.search": MEDIA_LIBRARY_SEARCH_SCHEMA,
  "emby.item": MEDIA_LIBRARY_ITEM_SCHEMA,
  "jellyfin.search": MEDIA_LIBRARY_SEARCH_SCHEMA,
  "jellyfin.item": MEDIA_LIBRARY_ITEM_SCHEMA,
  "immich.search": IMMICH_SEARCH_SCHEMA,
};

export const MEDIA_LOOKUP_DESCRIPTIONS: Record<MediaLookupToolName, string> = {
  "emby.search": "Search the configured Emby library by title, person, or year. Returns verified item ids.",
  "emby.item": "Read one Emby item: overview, year, genres, people, and the server community rating.",
  "jellyfin.search": "Search the configured Jellyfin library by title, person, or year. Returns verified item ids.",
  "jellyfin.item": "Read one Jellyfin item: overview, year, genres, people, and the server community rating.",
  "immich.search": "Semantic Immich search. Matches image content with the server machine-learning index. Not a filename search. A failure stays visible.",
};

export const MEDIA_READ_TOOL_NAMES = [
  ...EMBY_TOOL_NAMES,
  ...JELLYFIN_TOOL_NAMES,
  ...IMMICH_TOOL_NAMES,
] as const;

export function clampMediaLimit(value: number | undefined, fallback = 20): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(40, Math.max(1, Math.trunc(value)));
}

export function clampMediaStart(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function clampMediaPage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

const SEARCH_PARAM_NAMES = {
  emby: {
    recursive: "Recursive",
    start: "StartIndex",
    limit: "Limit",
    fields: "Fields",
    types: "IncludeItemTypes",
    term: "SearchTerm",
    person: "Person",
    years: "Years",
  },
  jellyfin: {
    recursive: "recursive",
    start: "startIndex",
    limit: "limit",
    fields: "fields",
    types: "includeItemTypes",
    term: "searchTerm",
    person: "person",
    years: "years",
  },
} as const;

/** Query string for Emby (PascalCase) or Jellyfin (OpenAPI camelCase) item search. */
export function mediaLibrarySearchQuery(
  query: MediaSearchQuery,
  service: "emby" | "jellyfin",
): string {
  const names = SEARCH_PARAM_NAMES[service];
  const params = new URLSearchParams();
  params.set(names.recursive, "true");
  params.set(names.start, String(clampMediaStart(query.startIndex)));
  params.set(names.limit, String(clampMediaLimit(query.limit)));
  params.set(names.fields, "Overview,Genres,People,ProviderIds");
  params.set(names.types, normalizeItemTypes(query.itemTypes));
  const term = query.query?.trim();
  if (term) params.set(names.term, term);
  const person = query.person?.trim();
  if (person) params.set(names.person, person);
  if (
    typeof query.year === "number" &&
    Number.isInteger(query.year) &&
    query.year >= 1000 &&
    query.year <= 9999
  ) {
    params.set(names.years, String(query.year));
  }
  return params.toString();
}

export function mediaItemPathSegment(id: string): string {
  const trimmed = id.trim();
  if (!trimmed || /[/?#\\]/.test(trimmed)) {
    throw new Error("Invalid item id");
  }
  return encodeURIComponent(trimmed);
}

function normalizeItemTypes(values: string[] | undefined): string {
  const picked = (values ?? []).filter((value) =>
    (MEDIA_ITEM_TYPES as readonly string[]).includes(value),
  );
  return picked.length > 0 ? picked.join(",") : "Movie,Series";
}

export const MEDIA_READ_SCHEMAS: Record<
  (typeof MEDIA_READ_TOOL_NAMES)[number],
  Record<string, unknown>
> = Object.fromEntries(
  MEDIA_READ_TOOL_NAMES.map((name) => [name, { type: "object", properties: {} }]),
) as unknown as Record<(typeof MEDIA_READ_TOOL_NAMES)[number], Record<string, unknown>>;

export const MEDIA_READ_DESCRIPTIONS: Record<
  (typeof MEDIA_READ_TOOL_NAMES)[number],
  string
> = {
  "emby.libraries": "List Emby media libraries (user views)",
  "emby.recent": "List recently added Emby items",
  "emby.sessions": "List Emby sessions (now playing)",
  "jellyfin.libraries": "List Jellyfin media libraries (user views)",
  "jellyfin.recent": "List recently added Jellyfin items",
  "jellyfin.sessions": "List Jellyfin sessions (now playing)",
  "immich.assets": "List Immich photo and video assets",
  "immich.albums": "List Immich albums",
  "immich.statistics": "Immich asset counts (images, videos, total)",
};

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(object: Json, key: string): string {
  const value = object[key];
  return typeof value === "string" ? value : "";
}

function numberField(object: Json, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const object = asObject(value);
  const entries = Object.entries(object).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mapPeople(value: unknown): MediaPerson[] {
  return asArray(value).flatMap((row) => {
    const person = asObject(row);
    const name = stringField(person, "Name");
    if (!name) return [];
    return [{
      id: stringField(person, "Id") || undefined,
      name,
      role: stringField(person, "Role") || undefined,
      type: stringField(person, "Type") || undefined,
    }];
  });
}

/** Map Emby/Jellyfin QueryResult.Items or a raw item array. */
export function mapMediaLibraries(payload: unknown): MediaLibrary[] {
  const root = asObject(payload);
  const rows = asArray(root.Items).length > 0 ? asArray(root.Items) : asArray(payload);
  return rows.map((row) => {
    const item = asObject(row);
    return {
      id: stringField(item, "Id"),
      title: stringField(item, "Name"),
      kind: stringField(item, "CollectionType") || stringField(item, "Type") || undefined,
    };
  }).filter((item) => item.id && item.title);
}

export function mapMediaItems(payload: unknown): MediaItem[] {
  return mapMediaSearch(payload).items.map((item) => ({
    id: item.id,
    title: item.title,
    type: item.type,
    year: item.year,
  }));
}

export function mapMediaItemDetail(payload: unknown): MediaItemDetail | undefined {
  const item = asObject(payload);
  const id = stringField(item, "Id");
  const title = stringField(item, "Name");
  if (!id || !title) return undefined;
  const genres = stringList(item.Genres);
  const people = mapPeople(item.People);
  const providerIds = stringRecord(item.ProviderIds);
  return {
    id,
    title,
    type: stringField(item, "Type") || undefined,
    year: numberField(item, "ProductionYear"),
    overview: stringField(item, "Overview") || undefined,
    ...(genres.length > 0 ? { genres } : {}),
    communityRating: numberField(item, "CommunityRating"),
    ...(people.length > 0 ? { people } : {}),
    ...(providerIds ? { providerIds } : {}),
  };
}

export function mapMediaSearch(payload: unknown): MediaSearchPage {
  const root = asObject(payload);
  const rows = asArray(root.Items).length > 0 ? asArray(root.Items) : asArray(payload);
  return {
    items: rows
      .map((row) => mapMediaItemDetail(row))
      .filter((item): item is MediaItemDetail => item !== undefined),
    total: numberField(root, "TotalRecordCount"),
  };
}

export function mapMediaSessions(payload: unknown): MediaSession[] {
  const rows = asArray(payload);
  return rows.map((row) => {
    const session = asObject(row);
    const playing = asObject(session.NowPlayingItem);
    const title =
      stringField(playing, "Name") ||
      stringField(session, "Client") ||
      stringField(session, "DeviceName");
    return {
      id: stringField(session, "Id"),
      title,
      client: stringField(session, "Client") || undefined,
      userName: stringField(session, "UserName") || undefined,
    };
  }).filter((item) => item.id);
}

export function mapPhotoAssets(payload: unknown): PhotoAsset[] {
  const root = asObject(payload);
  const assets = asObject(root.assets);
  const rows =
    asArray(assets.items).length > 0
      ? asArray(assets.items)
      : asArray(root.items).length > 0
        ? asArray(root.items)
        : asArray(payload);
  return rows.map((row) => {
    const item = asObject(row);
    return {
      id: stringField(item, "id"),
      title: stringField(item, "originalFileName"),
      type: stringField(item, "type") || undefined,
    };
  }).filter((item) => item.id && item.title);
}

export function mapPhotoAlbums(payload: unknown): PhotoAlbum[] {
  const rows = asArray(payload);
  return rows.map((row) => {
    const album = asObject(row);
    return {
      id: stringField(album, "id"),
      title: stringField(album, "albumName"),
      assetCount: numberField(album, "assetCount"),
    };
  }).filter((item) => item.id && item.title);
}

export function mapPhotoStatistics(payload: unknown): PhotoStatistics {
  const stats = asObject(payload);
  return {
    images: numberField(stats, "images") ?? 0,
    videos: numberField(stats, "videos") ?? 0,
    total: numberField(stats, "total") ?? 0,
  };
}
