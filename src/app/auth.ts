import type { RuntimeAuth } from "../agent/runtime/interface.ts";

/**
 * API-key and OAuth lifecycle stay on the runtime.
 * Pi keeps its own OAuth tokens; Antigravity credentials are written by the
 * Google adapter under the agent directory (see `adapters/google/antigravity.ts`).
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
