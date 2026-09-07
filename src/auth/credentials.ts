import type { Model, Models } from "@earendil-works/pi-ai";

/**
 * Thin provider pick for HTTP/TUI. Resolution, refresh, and storage stay in
 * pi-ai `Models.getAuth` — Thebe does not keep OAuth tokens.
 */
export async function resolveThebeAuth(
  models: Models,
  provider: string | Model<string>,
) {
  return models.getAuth(provider as never);
}
