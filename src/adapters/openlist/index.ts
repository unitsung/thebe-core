import { OpenListStrmRepairProvider } from "./strm-repair.ts";

export { OpenListStrmRepairProvider } from "./strm-repair.ts";
export type { OpenListStrmRepairProviderOptions } from "./strm-repair.ts";

/** Build the optional provider owned by the Core composition root. */
export function createOpenListStrmRepairProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenListStrmRepairProvider | undefined {
  const baseUrl = [env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL]
    .map((value) => value?.trim() ?? "")
    .find((value) => value.length > 0) ?? "";
  const token = [env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN]
    .map((value) => value?.trim() ?? "")
    .find((value) => value.length > 0) ?? "";
  if (!baseUrl || !token) return undefined;
  return new OpenListStrmRepairProvider({ baseUrl, token });
}
