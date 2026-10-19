import {
  PERMISSION_MODES,
  parsePermissionMode,
} from "../../../agent/runtime/interface.ts";
import { checkAgentInstructions } from "../../../agent/settings/instructions.ts";
import type { AgentSettingsPatch } from "../../../agent/settings/product.ts";
import { parseNetworkHostList } from "../../../agent/security/network-policy.ts";
import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody, restartRequired } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";

export async function handleSettingsRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const isAgentSettings = context.path === PRODUCT_HTTP_PATH.agentSettings;
  const isPermissionSettings = context.path.startsWith(
    PRODUCT_HTTP_PATH.permissionSettings
  );
  const isFullAccessSettings =
    context.path === PRODUCT_HTTP_PATH.fullAccessSettings;
  if (!isAgentSettings && !isPermissionSettings && !isFullAccessSettings) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, agent } = context;
  try {
    if (isFullAccessSettings) {
      if (request.method === "GET") {
        return json(agent.getFullAccessSupport());
      }
      return undefined;
    }
    if (isAgentSettings) {
      if (request.method === "GET") return json(agent.getAgentSettings());
      if (request.method === "PATCH") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        const body = await readJson(request);
        const patch: AgentSettingsPatch = {};
        const mutableKeys = new Set([
          "autoCompact",
          "autoSummary",
          "autoSummaryDelayMs",
          "instructions",
          "sandboxEnabled",
          "sandboxAllowedDomains",
          "sandboxDeniedDomains",
        ]);
        if (
          Object.prototype.hasOwnProperty.call(body, "maxSubagentConcurrency")
        ) {
          if (
            typeof body.maxSubagentConcurrency !== "number" ||
            !Number.isFinite(body.maxSubagentConcurrency)
          ) {
            return invalidBody(
              "maxSubagentConcurrency must be a finite number"
            );
          }
          return restartRequired(
            "maxSubagentConcurrency requires a Core restart"
          );
        }
        if (
          Object.prototype.hasOwnProperty.call(body, "maxSubagentsPerParent")
        ) {
          if (
            typeof body.maxSubagentsPerParent !== "number" ||
            !Number.isFinite(body.maxSubagentsPerParent)
          ) {
            return invalidBody("maxSubagentsPerParent must be a finite number");
          }
          return restartRequired(
            "maxSubagentsPerParent requires a Core restart"
          );
        }
        for (const key of Object.keys(body)) {
          if (!mutableKeys.has(key)) {
            return invalidBody(
              `${key} cannot be updated through /v1/settings/agent`
            );
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, "autoCompact")) {
          if (typeof body.autoCompact !== "boolean") {
            return invalidBody("autoCompact must be a boolean");
          }
          patch.autoCompact = body.autoCompact;
        }
        if (Object.prototype.hasOwnProperty.call(body, "autoSummary")) {
          if (typeof body.autoSummary !== "boolean") {
            return invalidBody("autoSummary must be a boolean");
          }
          patch.autoSummary = body.autoSummary;
        }
        if (Object.prototype.hasOwnProperty.call(body, "autoSummaryDelayMs")) {
          if (
            typeof body.autoSummaryDelayMs !== "number" ||
            !Number.isFinite(body.autoSummaryDelayMs)
          ) {
            return invalidBody("autoSummaryDelayMs must be a finite number");
          }
          patch.autoSummaryDelayMs = body.autoSummaryDelayMs;
        }
        if (Object.prototype.hasOwnProperty.call(body, "instructions")) {
          const checked = checkAgentInstructions(body.instructions);
          if (!checked.ok) return invalidBody(checked.message);
          patch.instructions = checked.value;
        }
        if (Object.prototype.hasOwnProperty.call(body, "sandboxEnabled")) {
          if (typeof body.sandboxEnabled !== "boolean") {
            return invalidBody("sandboxEnabled must be a boolean");
          }
          patch.sandboxEnabled = body.sandboxEnabled;
        }
        if (
          Object.prototype.hasOwnProperty.call(body, "sandboxAllowedDomains")
        ) {
          const parsed = parseNetworkHostList(
            body.sandboxAllowedDomains,
            "sandboxAllowedDomains"
          );
          if (!parsed.ok) return invalidBody(parsed.message);
          patch.sandboxAllowedDomains = parsed.hosts;
        }
        if (
          Object.prototype.hasOwnProperty.call(body, "sandboxDeniedDomains")
        ) {
          const parsed = parseNetworkHostList(
            body.sandboxDeniedDomains,
            "sandboxDeniedDomains"
          );
          if (!parsed.ok) return invalidBody(parsed.message);
          patch.sandboxDeniedDomains = parsed.hosts;
        }
        if (Object.keys(patch).length === 0) {
          return invalidBody("at least one Agent setting is required");
        }
        return json(await agent.updateAgentSettings(patch));
      }
      return undefined;
    }
    if (request.method === "GET") {
      return json({ mode: agent.permissionMode() });
    }
    if (request.method === "PATCH") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      const mode = parsePermissionMode(body.mode);
      if (!mode) {
        return invalidBody(`mode must be ${PERMISSION_MODES.join(", ")}`);
      }
      await agent.updatePermissionMode(mode);
      return json({ mode: agent.permissionMode() });
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
