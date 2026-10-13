import { OpenListStrmRepairProvider } from "./strm-repair.ts";
import { OpenListBackgroundTaskProvider } from "./tasks.ts";

export { OpenListStrmRepairProvider } from "./strm-repair.ts";
export type { OpenListStrmRepairProviderOptions } from "./strm-repair.ts";
export { OpenListBackgroundTaskProvider } from "./tasks.ts";
export type { OpenListBackgroundTaskProviderOptions } from "./tasks.ts";

type OpenListCredentials = { baseUrl: string; token: string };

/** Build the optional provider owned by the Core composition root. */
export function createOpenListStrmRepairProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): OpenListStrmRepairProvider | undefined {
  const credentials = openListCredentialsFromEnv(env);
  return credentials ? new OpenListStrmRepairProvider(credentials) : undefined;
}

export function createOpenListBackgroundTaskProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): OpenListBackgroundTaskProvider | undefined {
  const credentials = openListCredentialsFromEnv(env);
  return credentials
    ? new OpenListBackgroundTaskProvider(credentials)
    : undefined;
}

function openListCredentialsFromEnv(
  env: Record<string, string | undefined>
): OpenListCredentials | undefined {
  const baseUrl =
    [env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL]
      .map((value) => value?.trim() ?? "")
      .find((value) => value.length > 0) ?? "";
  const token =
    [env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN]
      .map((value) => value?.trim() ?? "")
      .find((value) => value.length > 0) ?? "";
  if (!baseUrl || !token) return undefined;
  return { baseUrl, token };
}
