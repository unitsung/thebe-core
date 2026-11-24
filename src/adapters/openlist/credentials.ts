export type OpenListCredentials = { baseUrl: string; token: string };

/** OpenList's address and token, from the first variable that is set. */
export function openListCredentialsFromEnv(
  env: Record<string, string | undefined>
): OpenListCredentials | undefined {
  const baseUrl = pick(env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL);
  const token = pick(env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN);
  if (!baseUrl || !token) return undefined;
  return { baseUrl, token };
}

function pick(...values: Array<string | undefined>): string {
  return (
    values
      .map((value) => value?.trim() ?? "")
      .find((value) => value.length > 0) ?? ""
  );
}
