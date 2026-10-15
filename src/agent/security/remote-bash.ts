/**
 * Host gate for running a client-supplied command in a session (`POST /v1/session/{id}/bash`).
 *
 * The route lets an App run one command it has already put in front of the user for approval.
 * It is off unless the host turns it on: a remote client cannot grant itself the ability.
 * `THEBE_REMOTE_BASH=on` (or `allow`/`true`/`1`/`yes`) enables it.
 */

export const REMOTE_BASH_ENV = "THEBE_REMOTE_BASH";

const ENABLING_VALUES = new Set(["on", "allow", "true", "1", "yes"]);

/** Output kept from one command; the rest is cut so a chatty command cannot flood a reply. */
export const REMOTE_BASH_OUTPUT_LIMIT = 30_000;

export function remoteBashAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[REMOTE_BASH_ENV]?.trim().toLowerCase();
  return value !== undefined && ENABLING_VALUES.has(value);
}
