import { json } from "../json.ts";

export function promptBodyError(result: { error: string; status?: number }): Response {
  return json({ error: result.error }, result.status ?? 400);
}

export function oauthCallbackInput(body: Record<string, unknown>): string | undefined {
  for (const key of ["url", "redirectUrl", "redirect_uri", "input"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return undefined;
  const state = typeof body.state === "string" ? body.state.trim() : "";
  return state ? `${code}#${state}` : code;
}

export function agentError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const extra = error instanceof Error ? error as Error & { status?: unknown; code?: unknown } : undefined;
  const body: Record<string, unknown> = { ok: false, error: message };
  if (typeof extra?.code === "string") body.code = extra.code;
  if (typeof extra?.status === "number" && Number.isInteger(extra.status) && extra.status >= 400 && extra.status < 600) {
    return json(body, extra.status);
  }
  const notFound = /unknown|no session|not found|AgentStore has no directory|invalid session id/i.test(message);
  return json(body, notFound ? 404 : 500);
}
