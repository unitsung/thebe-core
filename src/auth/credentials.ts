import type { RuntimeAuth } from "../runtime/types.ts";

/**
 * API-key and OAuth lifecycle stay on the runtime (Pi ModelRuntime).
 * Thebe does not store or refresh OAuth tokens.
 */
export async function applyThebeApiKey(
  auth: RuntimeAuth,
  providerId: string,
  apiKey: string,
): Promise<void> {
  await auth.setApiKey(providerId, apiKey);
}

export async function loginThebeOAuth(
  auth: RuntimeAuth,
  providerId: string,
): Promise<{ kind: "oauth"; providerId: string }> {
  return auth.loginOAuth(providerId, { type: "oauth" });
}
