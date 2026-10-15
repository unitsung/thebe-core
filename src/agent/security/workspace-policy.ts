import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  PermissionPreflightDecision,
  PermissionRequest,
} from "../runtime/index.ts";

/** Read-only Pi tools whose path arguments are governed by the workspace boundary. */
export const WORKSPACE_READ_TOOLS = ["read", "ls", "find", "grep"] as const;

function isWorkspaceReadTool(toolName: string): boolean {
  return (WORKSPACE_READ_TOOLS as readonly string[]).includes(toolName);
}

function requestPath(request: PermissionRequest): string | undefined {
  if (!request.args || typeof request.args !== "object") return undefined;
  const args = request.args as Record<string, unknown>;
  const value = args.path;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

/**
 * Whether a tool may change `rawPath` without asking under `acceptEdits`: it resolves, through
 * symlinks, to a place inside the workspace and not into `.git`, which Codex's workspace-write
 * sandbox also keeps read-only. A file that does not exist yet is judged by its nearest existing
 * parent.
 */
export async function isAutoEditablePath(
  workspacePath: string,
  rawPath: string
): Promise<boolean> {
  const root = await realpath(resolve(workspacePath)).catch(() =>
    resolve(workspacePath)
  );
  let existing = resolve(root, rawPath);
  const rest: string[] = [];
  for (;;) {
    const real = await realpath(existing).catch(() => undefined);
    if (real) {
      existing = real;
      break;
    }
    const parent = dirname(existing);
    if (parent === existing) return false;
    rest.unshift(basename(existing));
    existing = parent;
  }
  const target = resolve(existing, ...rest);
  if (!isInside(target, root)) return false;
  return !relative(root, target).split(sep).includes(".git");
}

export function createWorkspaceAccessPolicy(workspacePath: string): {
  workspacePath: string;
  preflight(request: PermissionRequest): Promise<PermissionPreflightDecision>;
} {
  const root = resolve(workspacePath);

  return {
    workspacePath: root,
    async preflight(request): Promise<PermissionPreflightDecision> {
      if (!isWorkspaceReadTool(request.toolName)) return "ask";

      const rawPath = requestPath(request);
      const canonicalRoot = await realpath(root).catch(() => root);
      const candidate = resolve(canonicalRoot, rawPath ?? ".");
      // Resolve existing symlinks so a path that looks in-workspace cannot
      // silently jump outside the configured boundary.
      const canonical = await realpath(candidate).catch(() => candidate);
      if (!isInside(canonical, canonicalRoot)) return "ask";

      return "allow";
    },
  };
}
