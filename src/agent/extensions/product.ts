import type { EnabledResource } from "../runtime/index.ts";
import type { SkillInfo } from "./skills.ts";
import type { HomelabCapability, McpServerInfo } from "./mcp.ts";
import { withProductMetadata } from "./mcp.ts";

export type ProductSkill = {
  name: string;
  description: string;
  scope: SkillInfo["scope"];
  enabled: boolean;
};

export function toProductSkill(skill: SkillInfo): ProductSkill {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    enabled: skill.enabled,
  };
}

export function toProductCapability(capability: HomelabCapability): HomelabCapability {
  return withProductMetadata(capability);
}

export function toProductMcpServer(server: McpServerInfo): McpServerInfo {
  return {
    name: server.name,
    command: server.command,
    url: server.url,
    service: server.service,
    category: server.category,
    permission: server.permission,
    status: server.status,
    disabled: server.disabled,
  };
}

export function toProductEnabledResource(resource: EnabledResource): EnabledResource {
  return {
    identity: resource.identity,
    version: resource.version,
    source: resource.source,
    kind: resource.kind,
  };
}
