import { json } from "./json.ts";
import { createDeviceRegistry, type DeviceRegistry } from "./devices.ts";
import { createThebeHttpContext, type ThebeHttpContext } from "./context.ts";
import { handleHealthEventsCompatibility } from "./routes/health.ts";
import { handleMcp } from "./routes/mcp.ts";
import { handleAgentRoutes } from "./routes/agent-api.ts";
import { handleActionRoutes } from "./routes/action.ts";
import { handleActivityRoutes } from "./routes/activity.ts";
import { handleArtifactRoutes } from "./routes/artifacts.ts";
import { handleAuditRoutes } from "./routes/audit.ts";
import { handleCapabilityRoutes } from "./routes/capability.ts";
import { handleDiagnosisRoutes } from "./routes/diagnosis.ts";
import { handleGoalRoutes } from "./routes/goal.ts";
import { handleTicketRoutes } from "./routes/tickets.ts";
import { handleEvalRoutes } from "./routes/eval.ts";
import { handleScheduleRoutes } from "./routes/schedules.ts";
import { handleMcpProductRoutes } from "./routes/mcp-product.ts";
import { handlePermissionRoutes } from "./routes/permission.ts";
import { handleResourceRoutes } from "./routes/resources.ts";
import { handleMemoryRoutes } from "./routes/memory.ts";
import { handleSettingsRoutes } from "./routes/settings.ts";
import { handleSkillRoutes } from "./routes/skills.ts";
import { handleSubagentRoutes } from "./routes/subagent.ts";
import { handleSystemRoutes } from "./routes/system.ts";
import { handleMetricsRoutes } from "./routes/metrics.ts";
import {
  createOpenApiDocument,
  swaggerUiAsset,
  swaggerUiHtml,
} from "./openapi.ts";
import { PRODUCT_HTTP_PATH } from "./product-paths.ts";
import { createRateLimiter, mcpRateLimitFromEnv } from "./rate-limit.ts";
import type { TokenCaller } from "./token-store.ts";

export type ThebeHttpRouterOptions = {
  version: string;
  agent?: ThebeHttpContext["agent"];
  deviceStoreDir?: string;
  deviceRegistry?: DeviceRegistry;
  pushIdentity?: ThebeHttpContext["pushIdentity"];
  quietHours?: ThebeHttpContext["quietHours"];
  workspacePath?: string;
  /** Calls a minute an external agent (a scoped token) may make over `/mcp`; 0 is no limit. */
  mcpRateLimit?: number;
};

export function createThebeHttpRouter(options: ThebeHttpRouterOptions) {
  const deviceRegistry =
    options.deviceRegistry ??
    createDeviceRegistry({ dir: options.deviceStoreDir });
  const mcpLimiter = createRateLimiter({
    limit: options.mcpRateLimit ?? mcpRateLimitFromEnv(),
  });
  return {
    async handle(request: Request, caller?: TokenCaller): Promise<Response> {
      const context = createThebeHttpContext(request, {
        ...options,
        caller,
        deviceRegistry,
      });

      if (request.method === "GET" && context.path === "/openapi.json") {
        return json(createOpenApiDocument(options.version), 200, {
          "cache-control": "no-cache",
        });
      }
      if (request.method === "GET") {
        const assetResponse = swaggerUiAsset(context.path);
        if (assetResponse) return assetResponse;
      }
      if (
        request.method === "GET" &&
        (context.path === "/docs" || context.path === "/swagger")
      ) {
        return new Response(swaggerUiHtml(options.version), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
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
      const metricsResponse = await handleMetricsRoutes(context);
      if (metricsResponse) {
        return metricsResponse;
      }

      const diagnosisResponse = await handleDiagnosisRoutes(context);
      if (diagnosisResponse) {
        return diagnosisResponse;
      }
      const actionResponse = await handleActionRoutes(context);
      if (actionResponse) {
        return actionResponse;
      }
      const artifactResponse = await handleArtifactRoutes(context);
      if (artifactResponse) {
        return artifactResponse;
      }
      const activityResponse = await handleActivityRoutes(context);
      if (activityResponse) {
        return activityResponse;
      }
      const auditResponse = await handleAuditRoutes(context);
      if (auditResponse) {
        return auditResponse;
      }
      const capabilityResponse = await handleCapabilityRoutes(context);
      if (capabilityResponse) {
        return capabilityResponse;
      }
      const subagentResponse = await handleSubagentRoutes(context);
      if (subagentResponse) {
        return subagentResponse;
      }
      const permissionResponse = await handlePermissionRoutes(context);
      if (permissionResponse) {
        return permissionResponse;
      }
      const skillResponse = await handleSkillRoutes(context);
      if (skillResponse) {
        return skillResponse;
      }
      const mcpProductResponse = await handleMcpProductRoutes(context);
      if (mcpProductResponse) {
        return mcpProductResponse;
      }
      const resourceResponse = await handleResourceRoutes(context);
      if (resourceResponse) {
        return resourceResponse;
      }
      const settingsResponse = await handleSettingsRoutes(context);
      if (settingsResponse) {
        return settingsResponse;
      }
      const memoryResponse = await handleMemoryRoutes(context);
      if (memoryResponse) {
        return memoryResponse;
      }
      const evalResponse = await handleEvalRoutes(context);
      if (evalResponse) return evalResponse;
      const ticketResponse = await handleTicketRoutes(context);
      if (ticketResponse) return ticketResponse;
      const goalResponse = await handleGoalRoutes(context);
      if (goalResponse) {
        return goalResponse;
      }
      const scheduleResponse = await handleScheduleRoutes(context);
      if (scheduleResponse) return scheduleResponse;
      if (isAgentRoute(context.path)) {
        return (await handleAgentRoutes(context)) ?? routeNotFound(context);
      }
      if (context.path === "/mcp") {
        // Stateless: no server-initiated SSE stream (GET) and no session to end (DELETE).
        if (request.method !== "POST") {
          return json(
            {
              ok: false,
              error: "/mcp accepts POST only",
              code: "method_not_allowed",
            },
            405,
            { allow: "POST" }
          );
        }
        // A scoped token is an external agent; the app and the operator's own tokens are not throttled.
        const wait = caller?.scopes ? mcpLimiter.take(caller.name) : undefined;
        if (wait !== undefined) {
          return json(
            {
              ok: false,
              error: `Too many calls over /mcp for ${caller?.name}; try again in ${wait}s (THEBE_MCP_RATE_LIMIT sets the limit)`,
              code: "rate_limited",
            },
            429,
            { "retry-after": String(wait) }
          );
        }
        return handleMcp(context);
      }
      return routeNotFound(context);
    },
  };
}

function routeNotFound(context: ThebeHttpContext): Response {
  return json(
    {
      ok: false,
      error: `No such route: ${context.request.method} ${context.path}`,
      code: "not_found",
    },
    404
  );
}

function isAgentRoute(path: string): boolean {
  return (
    path.startsWith("/v1/session") ||
    path.startsWith("/v1/provider") ||
    path.startsWith("/v1/model") ||
    path.startsWith("/v1/auth") ||
    path === PRODUCT_HTTP_PATH.capabilities ||
    path.startsWith("/v1/goals")
  );
}
