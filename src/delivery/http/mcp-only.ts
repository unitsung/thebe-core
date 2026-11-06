import { normalizedPath } from "./context.ts";
import type { createThebeHttpHandler } from "./handler.ts";
import { json } from "./json.ts";

/** What the gateway port answers to. `/mcp` is the only route; OAuth endpoints would join it here. */
const GATEWAY_PATHS = new Set(["/mcp"]);

/**
 * The same handler, narrowed to the routes an external agent needs. Put on its own port it is the one
 * thing to expose to the internet: `/v1/*`, the OpenAPI document and `/docs` answer `404` there, so
 * they cannot be reached or even discovered, and the token, Host and scope checks still run for `/mcp`.
 */
export function createMcpOnlyHandler(
  app: Pick<ReturnType<typeof createThebeHttpHandler>, "handle">
) {
  return {
    async handle(request: Request): Promise<Response> {
      const path = normalizedPath(new URL(request.url));
      if (!GATEWAY_PATHS.has(path)) {
        return json({ ok: false, error: "Not found", code: "not_found" }, 404);
      }
      return app.handle(request);
    },
  };
}
