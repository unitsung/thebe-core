import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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
