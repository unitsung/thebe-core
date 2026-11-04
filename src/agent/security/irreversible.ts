/**
 * Which calls cannot be undone, and the host switch that refuses them over `/mcp`.
 *
 * Irreversible is judged per call (the tool plus its arguments), never by the model or the caller:
 * the same `download.delete` is an ordinary write when it removes only the task and irreversible when
 * `deleteFiles` is true. Known cases: deleting a download together with its files, and deleting a
 * Navidrome playlist (treated as irreversible until Navidrome is shown to keep a recoverable copy).
 *
 * Writes Core cannot classify by name follow rules instead. A generic OpenAPI write is irreversible
 * when its method is DELETE or when an argument that means "also delete the data" is true; an external
 * MCP tool is irreversible when its server declares it destructive. The operator can override either,
 * one operation or tool at a time, and the gate audits every override that changed a verdict. Core's
 * remote shell is irreversible as a whole, because a command cannot be classified. Moving or copying
 * files is an ordinary write because the file provider fails on a name clash before it changes anything.
 * When unsure, a call counts as irreversible.
 */

/**
 * What a registered write says about itself: `true` always irreversible, `false` never, `"by_call"` when
 * the arguments decide. A new provider's write cannot be registered without one.
 */
export type IrreversibleDeclaration = boolean | "by_call";

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
  if (name === REMOTE_SHELL_CALL) {
    // A command cannot be classified, so the shell is irreversible as a whole.
    return {
      reason:
        "a shell command cannot be classified, so every one counts as an irreversible delete",
    };
  }
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

/** The remote shell (`POST /v1/session/{id}/bash`), named as the audit log names it. */
export const REMOTE_SHELL_CALL = "session.bash";

/** A verdict, and whether an operator override (not the rules) decided it. */
export type CallJudgement = {
  irreversible: { reason: string } | undefined;
  /** The operator's override differed from what the rules would have said. */
  overridden: boolean;
};

const OPERATOR_SAID_IRREVERSIBLE = {
  reason: "the operator marked this as irreversible",
};

function withOverride(
  rules: { reason: string } | undefined,
  override: boolean | undefined
): CallJudgement {
  if (override === undefined) return { irreversible: rules, overridden: false };
  return {
    irreversible: override ? (rules ?? OPERATOR_SAID_IRREVERSIBLE) : undefined,
    overridden: override !== (rules !== undefined),
  };
}

/** Argument names that mean "also delete the data": `deleteFiles`, `removeData`, `purge`, `wipe`, ... */
function deleteLikeName(name: string): boolean {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    plain.startsWith("delete") ||
    plain.startsWith("purge") ||
    plain.startsWith("wipe") ||
    plain.startsWith("erase") ||
    plain.startsWith("destroy") ||
    /^remove(files?|data|content|everything|all)/.test(plain)
  );
}

function truthy(value: unknown): boolean {
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return typeof value === "number" ? value !== 0 : value === true;
}

/**
 * The name of a delete-like argument that is true, looking at each given object's own keys and at the
 * query string of any string given as a path. A flag that is `false` or absent asks for nothing.
 */
export function truthyDeleteArgument(
  ...sources: unknown[]
): string | undefined {
  for (const source of sources) {
    if (typeof source === "string") {
      const query = source.includes("?")
        ? source.slice(source.indexOf("?") + 1)
        : "";
      for (const [name, value] of new URLSearchParams(query)) {
        if (deleteLikeName(name) && truthy(value)) return name;
      }
    } else if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const [name, value] of Object.entries(source)) {
        if (deleteLikeName(name) && truthy(value)) return name;
      }
    }
  }
  return undefined;
}

/**
 * A generic OpenAPI write: irreversible when its method is DELETE, or when a delete-like argument is
 * true in the arguments, the body or the path's query. `override` is the operator's verdict for this one
 * operation; it replaces the rules in either direction.
 */
export function judgeOpenApiWrite(input: {
  method: string;
  /** Argument objects, the request body and the request path, in any order. */
  sources: unknown[];
  override?: boolean;
}): CallJudgement {
  const method = input.method.trim().toUpperCase();
  const flag = truthyDeleteArgument(...input.sources);
  const rules =
    method === "DELETE"
      ? { reason: "its method is DELETE, which removes data for good" }
      : flag
        ? { reason: `${flag} is true, which also deletes the data` }
        : undefined;
  return withOverride(rules, input.override);
}

/**
 * An external MCP server's tool: irreversible when the server declares `destructiveHint: true`. A server's
 * claims can only tighten this, never loosen it; only the operator's override can mark a tool ordinary.
 */
export function judgeExternalMcpTool(input: {
  destructiveHint: boolean;
  override?: boolean;
}): CallJudgement {
  return withOverride(
    input.destructiveHint
      ? { reason: "its server declares it destructive" }
      : undefined,
    input.override
  );
}
