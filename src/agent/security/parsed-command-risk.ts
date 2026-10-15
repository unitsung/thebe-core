import { literalWord, parseScriptSync } from "./shell-parse.ts";
import type { Node } from "web-tree-sitter";

/**
 * What the command guard finds by reading a script as shell, not as text. The regex rules in
 * `command-risk.ts` see the spelling of a command; this pass sees the commands it runs, so quoting
 * tricks (`r''m`), split flags (`rm -r -f`), nested shells (`sh -c '…'`), `eval`, a pipe into a shell,
 * and a `$HOME` or `*` target are judged as what they are. It can only raise a verdict: a script it
 * cannot parse, or a parser that is not loaded, yields nothing and the regex rules decide alone.
 */
export type ParsedRisk = { risk: "critical" | "dangerous"; reason: string };

const MAX_DEPTH = 6;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "nice", "time", "command", "exec", "timeout"]);
const FETCHERS = new Set(["curl", "wget"]);
const SENSITIVE_READ =
  /(^|\/)\.ssh\/(id_[^/]*|[^/]*_key|authorized_keys)$|\/etc\/(shadow|gshadow|sudoers)|(^|\/)\.aws\/credentials$|(^|\/)\.gnupg(\/|$)|(^|\/)\.kube\/config$/;
const NOT_A_READ = new Set(["ls", "stat", "test", "[", "chmod", "chown"]);

type State = { atRoot: boolean };
type Arg = { text: string; value: string | undefined };

export function parsedCommandRisk(
  script: string,
  /** Whether a recursive operation on this path is catastrophic (the regex rules decide). */
  isProtected: (path: string) => boolean,
  depth = 0
): ParsedRisk | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const root = parseScriptSync(script);
  if (!root) return undefined;
  const state: State = { atRoot: false };
  let found: ParsedRisk | undefined;
  const raise = (next: ParsedRisk) => {
    if (!found || (next.risk === "critical" && found.risk !== "critical")) found = next;
  };
  const visit = (node: Node) => {
    if (node.type === "pipeline") {
      const names = node.namedChildren.flatMap((child) =>
        child?.type === "command" ? [commandName(child)] : []
      );
      const last = names[names.length - 1];
      if (names.slice(0, -1).some((n) => n && FETCHERS.has(n)) && last && SHELLS.has(last)) {
        raise({ risk: "dangerous", reason: "Downloads a script and runs it without looking at it" });
      }
    }
    if (node.type === "command") {
      const risk = commandRisk(node, state, isProtected, depth);
      if (risk) raise(risk);
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return found;
}

function commandName(command: Node): string | undefined {
  const name = command.namedChildren.find((child) => child?.type === "command_name")?.namedChild(0);
  const word = name && literalWord(name);
  return word ? word.split("/").pop() : undefined;
}

function commandRisk(
  command: Node,
  state: State,
  isProtected: (path: string) => boolean,
  depth: number
): ParsedRisk | undefined {
  let name: string | undefined;
  let nameNode: Node | undefined;
  const args: Arg[] = [];
  for (const child of command.namedChildren) {
    if (!child) continue;
    if (child.type === "command_name") {
      nameNode = child.namedChild(0) ?? undefined;
    } else if (nameNode && child.type !== "file_redirect" && child.type !== "heredoc_redirect") {
      args.push({ text: child.text, value: literalWord(child) });
    }
  }
  if (!nameNode) return undefined;
  const literal = literalWord(nameNode);
  if (literal === undefined) {
    return { risk: "dangerous", reason: "Runs a command whose name is only known at run time" };
  }
  name = literal.split("/").pop()!;
  return argvRisk(name, args, state, isProtected, depth);
}

function argvRisk(
  name: string,
  args: Arg[],
  state: State,
  isProtected: (path: string) => boolean,
  depth: number
): ParsedRisk | undefined {
  if (name === "cd") {
    state.atRoot = args.length === 1 && args[0]!.value === "/";
    return undefined;
  }
  if (WRAPPERS.has(name)) {
    const rest = args.filter((a, i) => !isWrapperNoise(name, a, args, i));
    const next = rest[0]?.value;
    return next ? argvRisk(next.split("/").pop()!, rest.slice(1), state, isProtected, depth) : undefined;
  }
  if (SHELLS.has(name)) {
    const at = args.findIndex((a) => a.value !== undefined && /^-[a-z]*c[a-z]*$/.test(a.value));
    if (at < 0) return undefined;
    const script = args[at + 1];
    if (!script) return undefined;
    if (script.value === undefined) {
      return { risk: "dangerous", reason: "Runs a shell command that is built at run time" };
    }
    return parsedCommandRisk(script.value, isProtected, depth + 1);
  }
  if (name === "eval") {
    if (args.some((a) => a.value === undefined)) {
      return { risk: "dangerous", reason: "Runs a shell command that is built at run time" };
    }
    return parsedCommandRisk(args.map((a) => a.value).join(" "), isProtected, depth + 1);
  }
  if (name === "rm") return rmRisk(args, state, isProtected);
  if (name === "find") return findRisk(args, state, isProtected);
  if ((name === "chmod" || name === "chown" || name === "chgrp") && recursive(args)) {
    const targets = operands(args).map((a) => target(a, state));
    return targets.some((t) => t === "/" || t === "/*" || isProtected(t))
      ? { risk: "critical", reason: `Recursive ${name} on the root, a system directory or a data volume` }
      : undefined;
  }
  if (!NOT_A_READ.has(name) && args.some((a) => SENSITIVE_READ.test(a.text.replace(/^["']|["']$/g, "").replace(/^~|^\$\{?HOME\}?/, "")))) {
    return { risk: "dangerous", reason: "Touches credentials or key material" };
  }
  return undefined;
}

/** Flags of the wrapper itself, `VAR=value` for env, and the number after timeout/nice. */
function isWrapperNoise(wrapper: string, arg: Arg, all: Arg[], index: number): boolean {
  const value = arg.value;
  if (value === undefined) return false;
  if (value.startsWith("-")) return true;
  if (wrapper === "env" && value.includes("=")) return true;
  if ((wrapper === "timeout" || wrapper === "nice") && /^\d+(\.\d+)?[smhd]?$/.test(value) && index === all.findIndex((a) => !a.value?.startsWith("-"))) {
    return true;
  }
  return false;
}

function recursive(args: Arg[]): boolean {
  return args.some((a) => {
    const v = a.value;
    return v !== undefined && (v === "--recursive" || (/^-[a-zA-Z]+$/.test(v) && /[rR]/.test(v)));
  });
}

function operands(args: Arg[]): Arg[] {
  return args.filter((a) => a.value === undefined || !a.value.startsWith("-"));
}

/** A path as the guard compares it: `$HOME` is the home directory, a glob after `cd /` is the root. */
function target(arg: Arg, state: State): string {
  if (arg.value !== undefined) return arg.value;
  const bare = arg.text.replace(/^["']|["']$/g, "");
  const home = bare.match(/^\$\{?HOME\}?(\/.*)?$/);
  if (home) return `~${home[1] ?? ""}`;
  if (/^\*+$/.test(bare)) return state.atRoot ? "/*" : "*";
  return "<run-time path>";
}

function rmRisk(args: Arg[], state: State, isProtected: (path: string) => boolean): ParsedRisk | undefined {
  if (!recursive(args)) return undefined;
  for (const arg of operands(args)) {
    const path = target(arg, state);
    if (path === "/" || path === "/*" || path === "~" || path.startsWith("~/") || isProtected(path)) {
      return { risk: "critical", reason: "Catastrophic file deletion targeting root, system, or home directory" };
    }
    if (path === "<run-time path>") {
      return { risk: "dangerous", reason: "Recursive delete of a path that is only known at run time" };
    }
  }
  return undefined;
}

function findRisk(args: Arg[], state: State, isProtected: (path: string) => boolean): ParsedRisk | undefined {
  const values = args.map((a) => a.value);
  const deletes =
    values.includes("-delete") ||
    values.some((v, i) => (v === "-exec" || v === "-execdir" || v === "-ok") && values[i + 1]?.split("/").pop() === "rm");
  if (!deletes) return undefined;
  const starts: Arg[] = [];
  for (const arg of args) {
    if (arg.value?.startsWith("-") || arg.value === "(" || arg.value === "!") break;
    starts.push(arg);
  }
  for (const arg of starts) {
    const path = target(arg, state);
    if (path === "/" || path === "/*" || path === "~" || path.startsWith("~/") || isProtected(path)) {
      return { risk: "critical", reason: "Bulk deletion with find under root, system, home or a data volume" };
    }
  }
  return undefined;
}
