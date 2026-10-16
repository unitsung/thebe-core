import type { MusicSourcesProvider } from "../../agent/capabilities/music-sources.ts";
import { createNeteaseProvider } from "./netease.ts";
import { createSqMusicProvider } from "./sqmusic.ts";
const clean = (value: string | undefined) => value?.trim() || undefined;
/** Optional personal music sources, each enabled only by its own environment variables. */
export function createMusicSourcesFromEnv(
  env: Record<string, string | undefined> = process.env
): MusicSourcesProvider | undefined {
  const netease = clean(env.THEBE_NETEASE_API_URL);
  const baseUrl = clean(env.THEBE_SQMUSIC_URL),
    username = clean(env.THEBE_SQMUSIC_USERNAME),
    password = clean(env.THEBE_SQMUSIC_PASSWORD);
  const sqmusic =
    baseUrl && username && password
      ? createSqMusicProvider({ baseUrl, username, password })
      : undefined;
  if (!netease && !sqmusic) return undefined;
  return {
    ...(netease ? { netease: createNeteaseProvider(netease) } : {}),
    ...(sqmusic ? { sqmusic } : {}),
  };
}
