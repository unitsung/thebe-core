import type { MediaLibraryProvider } from "../../agent/capabilities/media.ts";
import { EmbyAdapter, type EmbyAdapterOptions } from "./adapter.ts";

export function createEmbyProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): MediaLibraryProvider | undefined {
  const options = embyOptionsFromEnv(env);
  return options ? new EmbyAdapter(options) : undefined;
}

export function embyOptionsFromEnv(
  env: Record<string, string | undefined>,
): EmbyAdapterOptions | undefined {
  const baseUrl = firstNonEmpty(env.THEBE_EMBY_BASE_URL, env.EMBY_BASE_URL);
  const apiKey = firstNonEmpty(env.THEBE_EMBY_API_KEY, env.EMBY_API_KEY);
  const userId = firstNonEmpty(env.THEBE_EMBY_USER_ID, env.EMBY_USER_ID);
  if (!baseUrl || !apiKey || !userId) return undefined;
  return { baseUrl, apiKey, userId };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean);
}
