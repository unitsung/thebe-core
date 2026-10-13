/**
 * Host gate for the session-scoped full-access preset.
 *
 * The preset is an explicit, host-config-only allowance. It is off by default;
 * a remote App/HTTP or `/mcp` client cannot grant itself the ability to enable
 * it. `THEBE_FULL_ACCESS=on` (or `allow`/`true`/`1`/`yes`) makes the preset
 * selectable for a session, but never turns it on by itself.
 */

export const FULL_ACCESS_ENV = "THEBE_FULL_ACCESS";

const ENABLING_VALUES = new Set(["on", "allow", "true", "1", "yes"]);

/** Whether this Core host permits the session-scoped full-access preset. */
export function fullAccessPresetAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = env[FULL_ACCESS_ENV]?.trim().toLowerCase();
  return value !== undefined && ENABLING_VALUES.has(value);
}
