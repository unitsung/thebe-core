/**
 * Which single calls delete something that cannot be brought back.
 *
 * Judged per call (tool and arguments), not per tool: `download_delete` with `deleteFiles: false`
 * only drops the task and is an ordinary write, with `deleteFiles: true` it removes the files too.
 * Over `/mcp` a caller needs the `mcp:irreversible` scope for these; anything unsure counts as
 * irreversible.
 */

export type IrreversibleCall = {
  name: string;
  args: Record<string, unknown>;
  /** The HTTP method a service API call will use, when Core knows it. */
  httpMethod?: string;
  /** A provider MCP tool whose server marked it destructive. */
  destructiveHint?: boolean;
  /** The operator's own mark on a service API operation; when set it replaces every other rule. */
  operatorMark?: boolean;
};

/**
 * The classification context resolved around a call, as the `/mcp` gate resolves it: from the
 * service operation catalogue, or from a provider tool's own configuration and annotations.
 */
export type IrreversibleContext = {
  httpMethod?: string;
  destructiveHint?: boolean;
  operatorMark?: boolean;
  /** What the call will really send, when its own arguments only name it (a confirm token). */
  sends?: Record<string, unknown>;
};

/** Argument names that ask a service to remove data along with the record. */
const DELETE_FLAGS = new Set([
  "deletefiles",
  "deletedata",
  "removedata",
  "removefiles",
  "purge",
  "wipe",
]);

/**
 * Actions that stop or remove what a service runs. A service write that names one is more than an
 * ordinary write: restarting a media server is work, taking it down or rebuilding it is not.
 */
const DESTRUCTIVE_ACTIONS = new Set([
  "stop",
  "remove",
  "delete",
  "destroy",
  "recreate",
  "reset",
  "kill",
  "shutdown",
  "prune",
  "wipe",
  "purge",
  "terminate",
  "down",
]);
/** A mutating service call that names one of these in its path also holds back the work. */
const DESTRUCTIVE_PATH_ACTIONS = new Set([...DESTRUCTIVE_ACTIONS, "pause"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const NAVIDROME_PLAYLIST_DELETE = "navidrome_playlist_delete";
const DOWNLOAD_DELETE = "download_delete";

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** The words in a tool name or path, `removeContainer` and `containers/remove` alike. */
function actionTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

/**
 * Why this call stops or removes what a service runs, or `undefined` when it does not. A provider's
 * own tools are judged by their server's hint, not by Core's vocabulary.
 */
function destructiveAction(call: IrreversibleCall): string | undefined {
  if (
    call.name !== DOWNLOAD_DELETE &&
    !call.name.startsWith("mcp:") &&
    actionTokens(call.name).some((token) => DESTRUCTIVE_ACTIONS.has(token))
  ) {
    return "stops or removes what its service runs";
  }
  const method =
    typeof call.args.method === "string"
      ? call.args.method.toUpperCase()
      : undefined;
  if (!method || SAFE_METHODS.has(method)) return undefined;
  if (DESTRUCTIVE_ACTIONS.has(method.toLowerCase()))
    return "asks the service to stop or remove what it runs";
  const path = typeof call.args.path === "string" ? call.args.path : undefined;
  if (
    path &&
    actionTokens(path).some((token) => DESTRUCTIVE_PATH_ACTIONS.has(token))
  ) {
    return "asks the service to stop or remove what it runs";
  }
  return undefined;
}

/** A delete-style flag set to true at the top level of the arguments or of a `body` object. */
function hasDeleteFlag(args: Record<string, unknown>): boolean {
  const scan = (record: Record<string, unknown>) =>
    Object.entries(record).some(
      ([key, value]) => DELETE_FLAGS.has(key.toLowerCase()) && truthy(value)
    );
  if (scan(args)) return true;
  const body = args.body;
  return Boolean(
    body && typeof body === "object" && !Array.isArray(body)
      ? scan(body as Record<string, unknown>)
      : false
  );
}

/** Why this call cannot be undone, or `undefined` when it is an ordinary write or a read. */
export function irreversibleReason(call: IrreversibleCall): string | undefined {
  if (call.operatorMark !== undefined) {
    return call.operatorMark
      ? "is marked irreversible in this service's configuration"
      : undefined;
  }
  if (call.name === DOWNLOAD_DELETE && truthy(call.args.deleteFiles)) {
    return "deletes the downloaded files from disk";
  }
  if (call.name === NAVIDROME_PLAYLIST_DELETE) {
    return "deletes a playlist";
  }
  if (call.httpMethod?.toUpperCase() === "DELETE") {
    return "sends an HTTP DELETE to the service";
  }
  if (call.destructiveHint === true) {
    return "uses a provider tool its server marks as destructive";
  }
  if (call.name !== DOWNLOAD_DELETE && hasDeleteFlag(call.args)) {
    return "asks the service to delete data along with the record";
  }
  return destructiveAction(call);
}

/** The refusal a caller without `mcp:irreversible` gets: what it would do and how to allow it. */
export function irreversibleRefusal(name: string, reason: string): string {
  return `${name} ${reason} and cannot be undone, and this token may not do that over /mcp. Make a token that may with: thebe token create <name> --scope mcp:irreversible`;
}
