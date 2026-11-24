import {
  openListCredentialsFromEnv,
  type OpenListCredentials,
} from "./credentials.ts";
import { OpenListStrmRepairProvider } from "./strm-repair.ts";
import { OpenListBackgroundTaskProvider } from "./tasks.ts";

export { OpenListStrmRepairProvider } from "./strm-repair.ts";
export type { OpenListStrmRepairProviderOptions } from "./strm-repair.ts";
export { OpenListBackgroundTaskProvider } from "./tasks.ts";
export type { OpenListBackgroundTaskProviderOptions } from "./tasks.ts";
export {
  openListCredentialsFromEnv,
  type OpenListCredentials,
} from "./credentials.ts";

/** Build the optional provider owned by the Core composition root. */
export function createOpenListStrmRepairProvider(
  credentials: OpenListCredentials
): OpenListStrmRepairProvider {
  return new OpenListStrmRepairProvider(credentials);
}

export function createOpenListBackgroundTaskProvider(
  credentials: OpenListCredentials
): OpenListBackgroundTaskProvider {
  return new OpenListBackgroundTaskProvider(credentials);
}

export function createOpenListStrmRepairProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): OpenListStrmRepairProvider | undefined {
  const credentials = openListCredentialsFromEnv(env);
  return credentials
    ? createOpenListStrmRepairProvider(credentials)
    : undefined;
}

export function createOpenListBackgroundTaskProviderFromEnv(
  env: Record<string, string | undefined> = process.env
): OpenListBackgroundTaskProvider | undefined {
  const credentials = openListCredentialsFromEnv(env);
  return credentials
    ? createOpenListBackgroundTaskProvider(credentials)
    : undefined;
}
