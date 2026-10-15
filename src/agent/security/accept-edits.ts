import type { PermissionRequest } from "../runtime/index.ts";
import {
  commandGuardPreflight,
  type AssessToolCallOptions,
} from "./command-risk.ts";
import { dangerousCommand } from "./dangerous-command.ts";
import { literalCommands } from "./shell-parse.ts";
import { isAutoEditablePath } from "./workspace-policy.ts";

/**
 * What `acceptEdits` runs without asking, following Codex's on-request policy with a restricted
 * sandbox: a file write the workspace confines is allowed, and so is a command when a sandbox that
 * can really enforce confinement runs it. The sandbox is what makes that safe, so nothing here tries
 * to list "safe" commands; with no enforcing sandbox a command is asked about as usual. Anything the
 * command guard flags is asked about either way, and so is what Codex's dangerous-command check
 * finds in a script that `tree-sitter-bash` can read. Other tools (memory, MCP, service writes) are never
 * approved here.
 */
export async function acceptEditsApproves(
  request: PermissionRequest,
  context: {
    workspacePath?: string;
    /** Whether a sandbox that enforces confinement will run a shell command. */
    sandboxEnforced(): boolean;
    guard: AssessToolCallOptions;
    commandGuard: boolean;
  }
): Promise<boolean> {
  const { toolName, args } = request;
  if (toolName !== "write" && toolName !== "edit" && toolName !== "bash") {
    return false;
  }
  if (
    context.commandGuard &&
    commandGuardPreflight(toolName, args, context.guard) !== undefined
  ) {
    return false;
  }
  if (toolName === "bash") {
    if (!context.sandboxEnforced()) return false;
    const command = (args as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string" || !command.trim()) return false;
    // A script that does not parse cannot be read, so it is asked about. Codex's own list of what to
    // ask about (a forced `rm`, through `sudo`, `env`, `trap` and `bash -c`) comes next.
    if ((await literalCommands(command)) === undefined) return false;
    return (await dangerousCommand(["bash", "-lc", command])) === undefined;
  }
  if (!context.workspacePath || !args || typeof args !== "object") return false;
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || !path.trim()) return false;
  return isAutoEditablePath(context.workspacePath, path.trim());
}
