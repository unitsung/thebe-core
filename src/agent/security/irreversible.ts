/**
 * Which calls cannot be undone, and the host switch that refuses them over `/mcp`.
 *
 * Irreversible is judged per call (the tool plus its arguments), never by the model or the caller:
 * the same `download.delete` is an ordinary write when it removes only the task and irreversible when
 * `deleteFiles` is true. Known cases: deleting a download together with its files, and deleting a
 * Navidrome playlist (treated as irreversible until Navidrome is shown to keep a recoverable copy).
 */

export const MCP_IRREVERSIBLE_ENV = "THEBE_MCP_IRREVERSIBLE";

const DISABLING_VALUES = new Set(["off", "deny", "false", "0", "no"]);

/**
 * Host switch: on by default, so a token made with `mcp:irreversible` may delete. With
 * `THEBE_MCP_IRREVERSIBLE=off` (or `deny`/`false`/`0`/`no`) every irreversible delete over `/mcp` is
 * refused whatever the token's scope. A client cannot change this for itself.
 */
export function mcpIrreversibleAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[MCP_IRREVERSIBLE_ENV]?.trim().toLowerCase();
  return value === undefined || !DISABLING_VALUES.has(value);
}

/**
 * Whether this tool call deletes something that cannot be recovered, and in words why. The
 * `download.delete` tool itself refuses a `deleteFiles` that is not a boolean, so only an exact
 * `true` can delete files; anything else removes at most the task.
 */
export function irreversibleCall(
  name: string,
  args: unknown
): { reason: string } | undefined {
  if (name === "navidrome.playlist.delete") {
    return { reason: "deleting a playlist cannot be undone" };
  }
  if (
    name === "download.delete" &&
    (args as { deleteFiles?: unknown } | null | undefined)?.deleteFiles === true
  ) {
    return {
      reason: "deleting a download together with its files cannot be undone",
    };
  }
  return undefined;
}
