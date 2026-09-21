import { json } from "./json.ts";
import {
  createThebeHttpContext,
  type ThebeHttpContext,
} from "./context.ts";
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
import { handleMcpProductRoutes } from "./routes/mcp-product.ts";
import { handlePermissionRoutes } from "./routes/permission.ts";
import { handleResourceRoutes } from "./routes/resources.ts";
import { handleSettingsRoutes } from "./routes/settings.ts";
import { handleSkillRoutes } from "./routes/skills.ts";
import { handleSubagentRoutes } from "./routes/subagent.ts";
import { handleSystemRoutes } from "./routes/system.ts";
import { createOpenApiDocument, swaggerUiAsset, swaggerUiHtml } from "./openapi.ts";
import { PRODUCT_HTTP_PATH } from "./product-paths.ts";

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
      const goalResponse = await handleGoalRoutes(context);
      if (goalResponse) {
        return goalResponse;
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
    path === PRODUCT_HTTP_PATH.capabilities ||
    path.startsWith("/v1/goals")
  );
}
