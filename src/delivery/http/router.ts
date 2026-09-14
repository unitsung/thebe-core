import { json } from "./json.ts";
import {
  createThebeHttpContext,
  type ThebeHttpContext,
} from "./context.ts";
import { handleHealthEventsCompatibility } from "./routes/health.ts";
import { handleMcp } from "./routes/mcp.ts";
import { handleAgentRoutes } from "./routes/agent-api.ts";
import { handleSystemRoutes } from "./routes/system.ts";
import { createOpenApiDocument, swaggerUiAsset, swaggerUiHtml } from "./openapi.ts";

export type ThebeHttpRouterOptions = {
  version: string;
  agent?: ThebeHttpContext["agent"];
};

export function createThebeHttpRouter(options: ThebeHttpRouterOptions) {
  const devices = new Map<
    string,
    { platform: string; deviceId?: string; registeredAt: string }
  >();
  return {
    async handle(request: Request): Promise<Response> {
      const context = createThebeHttpContext(request, { ...options, devices });

      if (request.method === "GET" && context.path === "/openapi.json") {
        return json(createOpenApiDocument(options.version), 200, {
          "cache-control": "no-cache",
        });
      }
      if (request.method === "GET") {
        const assetResponse = swaggerUiAsset(context.path);
        if (assetResponse) return assetResponse;
      }
      if (request.method === "GET" && (context.path === "/docs" || context.path === "/swagger")) {
        return new Response(swaggerUiHtml(options.version), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
            "x-content-type-options": "nosniff",
          },
        });
      }

      const healthResponse = await handleHealthEventsCompatibility(context);
      if (healthResponse) {
        return healthResponse;
      }
      const systemResponse = await handleSystemRoutes(context);
      if (systemResponse) {
        return systemResponse;
      }

      if (isAgentRoute(context.path)) {
        return (await handleAgentRoutes(context)) ?? json({ ok: false }, 404);
      }
      if (request.method === "POST" && context.path === "/mcp") {
        return handleMcp(context);
      }
      return json({ ok: false }, 404);
    },
  };
}

function isAgentRoute(path: string): boolean {
  return (
    path.startsWith("/v1/session") ||
    path.startsWith("/v1/provider") ||
    path.startsWith("/v1/model") ||
    path.startsWith("/v1/auth") ||
    path === "/v1/capabilities"
  );
}
