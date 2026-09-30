import type { MediaLibraryProvider } from "../../agent/capabilities/media.ts";
import { JellyfinAdapter, type JellyfinAdapterOptions } from "./adapter.ts";

export function createJellyfinProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): MediaLibraryProvider | undefined {
  const options = jellyfinOptionsFromEnv(env);
  return options ? new JellyfinAdapter(options) : undefined;
}

export function jellyfinOptionsFromEnv(
  env: Record<string, string | undefined>,
): JellyfinAdapterOptions | undefined {
  const baseUrl = firstNonEmpty(env.THEBE_JELLYFIN_BASE_URL, env.JELLYFIN_BASE_URL);
  const apiKey = firstNonEmpty(env.THEBE_JELLYFIN_API_KEY, env.JELLYFIN_API_KEY);
  const userId = firstNonEmpty(env.THEBE_JELLYFIN_USER_ID, env.JELLYFIN_USER_ID);
  if (!baseUrl || !apiKey || !userId) return undefined;
  return { baseUrl, apiKey, userId };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean);
}
