import { TOKEN_SCOPES } from "../token-store.ts";

export const MCP_OAUTH_SCOPES = TOKEN_SCOPES;
export const OAUTH_GLOBAL_SCOPES = ["offline_access"] as const;
export const OAUTH_SUPPORTED_SCOPES = [
  ...TOKEN_SCOPES,
  ...OAUTH_GLOBAL_SCOPES,
] as const;

const PROTECTED_RESOURCE_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);

export function isProtectedResourceMetadataPath(path: string): boolean {
  return PROTECTED_RESOURCE_PATHS.has(path);
}

export function protectedResourceMetadataPath(resource: string): string {
  const url = new URL(resource);
  const suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `/.well-known/oauth-protected-resource${suffix}`;
}

export function protectedResourceMetadataUrl(resource: string): string {
  return new URL(protectedResourceMetadataPath(resource), resource).toString();
}

export function protectedResourceMetadata(options: {
  issuer: string;
  resource: string;
  resourceName?: string;
}): Record<string, unknown> {
  return {
    resource: options.resource,
    authorization_servers: [options.issuer],
    scopes_supported: MCP_OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: options.resourceName ?? "Thebe MCP gateway",
  };
}

export function bearerChallenge(resource: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(resource)}"`;
}
