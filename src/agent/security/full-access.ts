/**
 * Whether a session may use `bypassPermissions`.
 *
 * It is always selectable. The TUI and the App ask before turning it on.
 * `THEBE_FULL_ACCESS` is ignored, the same as leaving it unset: it does not
 * start the process in bypass, and it is not required.
 */

export const FULL_ACCESS_ENV = "THEBE_FULL_ACCESS";

/** Bypass can be selected on every host. The environment value is ignored. */
export function fullAccessPresetAllowed(
  _env: NodeJS.ProcessEnv = process.env
): boolean {
  return true;
}
