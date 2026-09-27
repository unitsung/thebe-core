import type { NavidromeProvider } from "../../agent/capabilities/navidrome.ts";
import {
  NavidromeAdapter,
  type NavidromeAdapterOptions,
} from "./adapter.ts";

export { NavidromeAdapter } from "./adapter.ts";
export type { NavidromeAdapterOptions } from "./adapter.ts";

/** Build the optional Navidrome provider owned by the Core composition root. */
export function createNavidromeProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): NavidromeProvider | undefined {
  const options = navidromeOptionsFromEnv(env);
  return options ? new NavidromeAdapter(options) : undefined;
}

export function navidromeOptionsFromEnv(
  env: Record<string, string | undefined>,
): NavidromeAdapterOptions | undefined {
  const baseUrl = firstNonEmpty(
    env.THEBE_NAVIDROME_BASE_URL,
    env.NAVIDROME_BASE_URL,
  );
  const username = firstNonEmpty(
    env.THEBE_NAVIDROME_USERNAME,
    env.NAVIDROME_USERNAME,
  );
  const password = firstNonEmpty(
    env.THEBE_NAVIDROME_PASSWORD,
    env.NAVIDROME_PASSWORD,
  );
  if (!baseUrl || !username || !password) return undefined;
  const fallbackUrl = firstNonEmpty(
    env.THEBE_NAVIDROME_FALLBACK_URL,
    env.NAVIDROME_FALLBACK_URL,
  );
  return {
    baseUrl,
    username,
    password,
    ...(fallbackUrl ? { fallbackUrl } : {}),
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean);
}
