/** Product HTTP prefixes and path segments. Routes and OpenAPI share these. */
export const PRODUCT_HTTP_PATH = {
  capabilities: "/v1/capabilities",
  subagents: "/v1/subagents",
  permissions: "/v1/permissions",
  skills: "/v1/skills",
  mcpExtensions: "/v1/extensions/mcp",
  enabledResources: "/v1/resources/enabled",
  permissionSettings: "/v1/settings/permissions",
} as const;

export const PRODUCT_HTTP_SEGMENT = {
  invoke: "invoke",
  runs: "runs",
  profiles: "profiles",
  log: "log",
  cancel: "cancel",
  resolve: "resolve",
  servers: "servers",
  tools: "tools",
} as const;
