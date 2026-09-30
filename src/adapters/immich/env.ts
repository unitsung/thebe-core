import type { PhotoLibraryProvider } from "../../agent/capabilities/media.ts";
import { ImmichAdapter, type ImmichAdapterOptions } from "./adapter.ts";

export function createImmichProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): PhotoLibraryProvider | undefined {
  const options = immichOptionsFromEnv(env);
  return options ? new ImmichAdapter(options) : undefined;
}

export function immichOptionsFromEnv(
  env: Record<string, string | undefined>,
): ImmichAdapterOptions | undefined {
  const baseUrl = firstNonEmpty(env.THEBE_IMMICH_BASE_URL, env.IMMICH_BASE_URL);
  const apiKey = firstNonEmpty(env.THEBE_IMMICH_API_KEY, env.IMMICH_API_KEY);
  if (!baseUrl || !apiKey) return undefined;
  return { baseUrl, apiKey };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean);
}
