/**
 * Which single calls delete something that cannot be brought back.
 *
 * Judged per call (tool and arguments), not per tool: `download.delete` with `deleteFiles: false`
 * only drops the task and is an ordinary write, with `deleteFiles: true` it removes the files too.
 * Over `/mcp` a caller needs the `mcp:irreversible` scope for these; anything unsure counts as
 * irreversible. See docs/research/irreversible-writes-2026-11-03.md for the list and the reasons.
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

/** Argument names that ask a service to remove data along with the record. */
const DELETE_FLAGS = new Set([
  "deletefiles",
  "deletedata",
  "removedata",
  "removefiles",
  "purge",
  "wipe",
]);

const NAVIDROME_PLAYLIST_DELETE = "navidrome.playlist.delete";
const DOWNLOAD_DELETE = "download.delete";

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
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
  return undefined;
}

/** The refusal a caller without `mcp:irreversible` gets: what it would do and how to allow it. */
export function irreversibleRefusal(name: string, reason: string): string {
  return `${name} ${reason} and cannot be undone, and this token may not do that over /mcp. Make a token that may with: thebe token create <name> --scope mcp:irreversible`;
}
