import { literalCommands, shellScriptOf } from "./shell-parse.ts";

/**
 * Whether a command is one to ask about before running it, ported from Codex
 * (`codex-rs/shell-command/src/command_safety/is_dangerous_command.rs`, POSIX part) with its tests.
 *
 * Codex flags little here: a forced `rm`, seen through `sudo`, `env`, `trap` and the scripts passed to
 * `bash -c`/`-lc`, however deeply they are nested. Everything else is left to the sandbox, which is
 * what makes running a command unasked acceptable.
 */
export type DangerousCommand = "forced-rm" | "other";

const MAX_WRAPPER_DEPTH = 8;

export async function dangerousCommand(
  argv: readonly string[],
  depth = 0
): Promise<DangerousCommand | undefined> {
  if (depth > MAX_WRAPPER_DEPTH) return "other";
  const direct = await dangerousExec(argv, depth);
  if (direct) return direct;
  // A script may hide the command anywhere: in control flow, a pipe or a substitution.
  const script = shellScriptOf(argv);
  if (script === undefined) return undefined;
  const nested = await literalCommands(script);
  for (const command of nested ?? []) {
    const found = await dangerousCommand(command, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function dangerousExec(
  argv: readonly string[],
  depth: number
): Promise<DangerousCommand | undefined> {
  const name = argv[0]?.split("/").pop();
  switch (name) {
    case "rm":
      return rmForces(argv.slice(1)) ? "forced-rm" : undefined;
    case "sudo":
      return dangerousCommand(argv.slice(1), depth + 1);
    case "env":
      return dangerousCommand(skipEnvPrefix(argv), depth + 1);
    case "trap": {
      // The action is shell source, held in the first operand.
      let index = 1;
      if (argv[index] === "--") index += 1;
      const action = argv[index];
      if (action === undefined || action.startsWith("-")) return undefined;
      return dangerousCommand(["sh", "-c", action], depth + 1);
    }
    default:
      return undefined;
  }
}

function skipEnvPrefix(argv: readonly string[]): readonly string[] {
  let index = 1;
  while (index < argv.length) {
    const argument = argv[index]!;
    if (argument === "--") {
      index += 1;
      break;
    }
    const assignment = argument.indexOf("=");
    if (
      argument === "-i" ||
      argument === "--ignore-environment" ||
      (assignment > 0 && !argument.startsWith("-"))
    ) {
      index += 1;
      continue;
    }
    break;
  }
  return argv.slice(index);
}

function rmForces(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") return false;
    if (argument === "--force") return true;
    if (argument.startsWith("-") && !argument.startsWith("--") && argument.includes("f")) {
      return true;
    }
  }
  return false;
}
