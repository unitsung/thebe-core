import { json } from "./json.ts";
import {
  createThebeHttpContext,
  type ThebeHttpContext,
} from "./context.ts";
import { handleHealthEventsCompatibility } from "./routes/health.ts";
import { handleMcp } from "./routes/mcp.ts";
import { handleAgentRoutes } from "./routes/agent-api.ts";
import { handleSystemRoutes } from "./routes/system.ts";

export type ThebeHttpRouterOptions = {
  version: string;
  agent?: ThebeHttpContext["agent"];
};

export function createThebeHttpRouter(options: ThebeHttpRouterOptions) {
  return {
    async handle(request: Request): Promise<Response> {
      const context = createThebeHttpContext(request, options);

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
    path.startsWith("/v1/auth")
  );
}
