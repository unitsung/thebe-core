/**
 * Host gate for write tools over `/mcp`.
 *
 * On by default: an agent connected over `/mcp` may call the write tools. Core does not ask anyone
 * first; the calling agent and its client are responsible for asking their user, and every write is
 * audited. `THEBE_MCP_WRITES=off` (or `deny`/`false`/`0`/`no`) makes `/mcp` read-only. A client
 * cannot change this for itself.
 */

export const MCP_WRITES_ENV = "THEBE_MCP_WRITES";

const DISABLING_VALUES = new Set(["off", "deny", "false", "0", "no"]);

export function mcpWritesAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[MCP_WRITES_ENV]?.trim().toLowerCase();
  return value === undefined || !DISABLING_VALUES.has(value);
}
