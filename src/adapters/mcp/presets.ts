import { openListCredentialsFromEnv } from "../openlist/credentials.ts";
import type { McpServerConfig } from "./config.ts";

export const OPENLIST_MCP_SERVER_NAME = "openlist";
export const OPENLIST_MCP_DESCRIPTION =
  "OpenList file manager (official MCP server): list, inspect and link files.";
/** The tools OpenList's built-in MCP server documents as its whole surface; all three only read. */
export const OPENLIST_MCP_READ_TOOLS = [
  "openlist.fs.list",
  "openlist.fs.get",
  "openlist.fs.link",
] as const;

const ENABLING_VALUES = new Set(["on", "true", "1", "yes", "enabled"]);

/**
 * OpenList's built-in MCP server is opt-in (`THEBE_OPENLIST_MCP=on`) because it duplicates part of
 * the native OpenList adapters. It also requires the server-side `"mcp": {"enable": true}` and a
 * user token: the token goes in `Authorization` verbatim, without a Bearer prefix.
 */
export function openListMcpEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const value = env.THEBE_OPENLIST_MCP?.trim().toLowerCase();
  return value !== undefined && ENABLING_VALUES.has(value);
}

/** `https://openlist.example.com` becomes its official MCP endpoint at `/mcp`. */
export function openListMcpEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/mcp$/i.test(trimmed) ? trimmed : `${trimmed}/mcp`;
}

export function openListMcpServerConfig(
  env: Record<string, string | undefined> = process.env
): McpServerConfig | undefined {
  if (!openListMcpEnabled(env)) return undefined;
  const credentials = openListCredentialsFromEnv(env);
  if (!credentials) return undefined;
  return {
    name: OPENLIST_MCP_SERVER_NAME,
    url: openListMcpEndpoint(credentials.baseUrl),
    headers: { Authorization: credentials.token },
    description: OPENLIST_MCP_DESCRIPTION,
    exposure: "deferred",
    service: "openlist",
    category: "files",
    readTools: [...OPENLIST_MCP_READ_TOOLS],
    disabled: false,
  };
}

/** Servers Core knows without a configuration-file entry. A file entry of the same name wins. */
export function presetMcpServers(
  env: Record<string, string | undefined> = process.env
): McpServerConfig[] {
  const openList = openListMcpServerConfig(env);
  return openList ? [openList] : [];
}
