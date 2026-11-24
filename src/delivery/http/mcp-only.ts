import { normalizedPath } from "./context.ts";
import type { createThebeHttpHandler } from "./handler.ts";
import { json } from "./json.ts";
import { isProtectedResourceMetadataPath } from "./oauth/metadata.ts";

/**
 * Fetch routes the gateway handler owns. OAuth discovery, authorization, token,
 * revocation, registration, and interaction routes run in the listener's Node
 * middleware before this handler.
 */
const GATEWAY_PATHS = new Set(["/mcp"]);

/**
 * The same handler, narrowed to the routes an external agent needs. Put on its own port it is the
 * public-facing listener: `/v1/*`, the OpenAPI document and `/docs` answer `404`, while `/mcp` and
 * protected-resource metadata keep the same token, Host, and scope checks.
 */
export function createMcpOnlyHandler(
  app: Pick<ReturnType<typeof createThebeHttpHandler>, "handle">
) {
  return {
    async handle(request: Request): Promise<Response> {
      const path = normalizedPath(new URL(request.url));
      if (!GATEWAY_PATHS.has(path) && !isProtectedResourceMetadataPath(path)) {
        return json({ ok: false, error: "Not found", code: "not_found" }, 404);
      }
      return app.handle(request);
    },
  };
}
