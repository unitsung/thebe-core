/**
 * Host gate for write tools over `/mcp`.
 *
 * Off by default: an external agent can read but not change anything. `THEBE_MCP_WRITES=on` (or
 * `allow`/`true`/`1`/`yes`) lets it call the write tools too. Core does not ask anyone first:
 * the client that calls the tool is responsible for asking its user, and the call is audited.
 * A client cannot turn this on for itself.
 */

export const MCP_WRITES_ENV = "THEBE_MCP_WRITES";

const ENABLING_VALUES = new Set(["on", "allow", "true", "1", "yes"]);

export function mcpWritesAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[MCP_WRITES_ENV]?.trim().toLowerCase();
  return value !== undefined && ENABLING_VALUES.has(value);
}
