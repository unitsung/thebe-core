import type { MediaLibraryProvider } from "../../agent/capabilities/media.ts";
import {
  MediaBrowserAdapter,
  type MediaBrowserAdapterOptions,
  type MediaBrowserFlavor,
} from "./adapter.ts";

/** `THEBE_EMBY_BASE_URL` or `EMBY_BASE_URL`, with `_API_KEY` and `_USER_ID`: the same three for each flavor. */
export function createMediaBrowserProviderFromEnv(
  flavor: MediaBrowserFlavor,
  env: Record<string, string | undefined> = process.env
): MediaLibraryProvider | undefined {
  const options = mediaBrowserOptionsFromEnv(flavor, env);
  return options ? new MediaBrowserAdapter(flavor, options) : undefined;
}

export function mediaBrowserOptionsFromEnv(
  flavor: MediaBrowserFlavor,
  env: Record<string, string | undefined>
): MediaBrowserAdapterOptions | undefined {
  const name = flavor.toUpperCase();
  const read = (field: string) =>
    firstNonEmpty(env[`THEBE_${name}_${field}`], env[`${name}_${field}`]);
  const baseUrl = read("BASE_URL");
  const apiKey = read("API_KEY");
  const userId = read("USER_ID");
  if (!baseUrl || !apiKey || !userId) return undefined;
  return { baseUrl, apiKey, userId };
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean);
}
