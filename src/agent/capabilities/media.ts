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
}

export interface PhotoLibraryProvider {
  listAssets(): Promise<PhotoAsset[]>;
  listAlbums(): Promise<PhotoAlbum[]>;
  getStatistics(): Promise<PhotoStatistics>;
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

export const MEDIA_READ_TOOL_NAMES = [
  ...EMBY_TOOL_NAMES,
  ...JELLYFIN_TOOL_NAMES,
  ...IMMICH_TOOL_NAMES,
] as const;

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
  const root = asObject(payload);
  const rows = asArray(root.Items).length > 0 ? asArray(root.Items) : asArray(payload);
  return rows.map((row) => {
    const item = asObject(row);
    return {
      id: stringField(item, "Id"),
      title: stringField(item, "Name"),
      type: stringField(item, "Type") || undefined,
      year: numberField(item, "ProductionYear"),
    };
  }).filter((item) => item.id && item.title);
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
