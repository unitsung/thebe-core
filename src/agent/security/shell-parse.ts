import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";

/**
 * Splitting a shell script into the commands it runs, with `tree-sitter-bash` (the grammar Codex's
 * `shell-command` crate and opencode both parse with) through `web-tree-sitter`. This is a port of
 * Codex's `parse_shell_lc_literal_commands` (`codex-rs/shell-command/src/bash.rs`): every command node
 * in a script that parses cleanly, nested in pipes, control flow and substitutions, with the words
 * that are known statically. A word that expands at run time (`$x`, `$(…)`, globs, `~`) is left out,
 * so the result can show a command is dangerous but never that it is safe.
 */

const require = createRequire(import.meta.url);

let parser: Promise<Parser> | undefined;

function bashParser(): Promise<Parser> {
  parser ??= (async () => {
    await Parser.init({
      locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
    });
    const bash = await Language.load(
      require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")
    );
    const created = new Parser();
    created.setLanguage(bash);
    return created;
  })();
  return parser;
}

let readyParser: Parser | undefined;

/** Loads the grammar once so the synchronous command guard can parse; call it at startup. */
export async function shellParserReady(): Promise<void> {
  readyParser = await bashParser();
}

/** The syntax tree of `script`, or `undefined` when the parser is not loaded or the script has errors. */
export function parseScriptSync(script: string): Node | undefined {
  const tree = readyParser?.parse(script);
  return tree && !tree.rootNode.hasError ? tree.rootNode : undefined;
}

/** `bash`/`zsh`/`sh` with `-c` or `-lc` and one script, as Codex's `extract_bash_command` accepts. */
export function shellScriptOf(argv: readonly string[]): string | undefined {
  if (argv.length !== 3) return undefined;
  const [shell, flag, script] = argv as [string, string, string];
  if (flag !== "-lc" && flag !== "-c") return undefined;
  const name = shell.split("/").pop();
  return name === "bash" || name === "zsh" || name === "sh" ? script : undefined;
}

/**
 * The statically known words of every command in `script`, or `undefined` when the script does not
 * parse cleanly (the caller must not treat that as safe).
 */
export async function literalCommands(script: string): Promise<string[][] | undefined> {
  const tree = (await bashParser()).parse(script);
  if (!tree || tree.rootNode.hasError) return undefined;
  const commands: string[][] = [];
  const stack: Node[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "command") {
      const words = literalCommand(node);
      if (words) commands.push(words);
    }
    for (const child of node.namedChildren) if (child) stack.push(child);
  }
  return commands;
}

function literalCommand(command: Node): string[] | undefined {
  const words: string[] = [];
  let foundName = false;
  for (const child of command.namedChildren) {
    if (!child) continue;
    if (child.type === "command_name") {
      const name = child.namedChild(0);
      const word = name && literalWord(name);
      if (word === undefined || word === null) return undefined;
      words.push(word);
      foundName = true;
    } else if (foundName) {
      const word = literalWord(child);
      if (word !== undefined && word !== null) words.push(word);
    }
  }
  return foundName ? words : undefined;
}

export function literalWord(node: Node): string | undefined {
  switch (node.type) {
    case "word":
    case "number":
      return isLiteralWord(node) ? node.text : undefined;
    case "string":
      return doubleQuoted(node);
    case "raw_string": {
      const text = node.text;
      return text.startsWith("'") && text.endsWith("'") && text.length >= 2
        ? text.slice(1, -1)
        : undefined;
    }
    case "concatenation": {
      let joined = "";
      for (const part of node.namedChildren) {
        const word = part && literalWord(part);
        if (word === undefined || word === null) return undefined;
        joined += word;
      }
      return joined ? joined : undefined;
    }
    default:
      return undefined;
  }
}

/** A word can still be expanded or have escapes removed; only a spelling that is already literal counts. */
function isLiteralWord(node: Node): boolean {
  if (node.namedChildren.length > 0) return false;
  const word = node.text;
  return !word.startsWith("=") && !/[{}*?[\]\\~^#$`]/.test(word);
}

function doubleQuoted(node: Node): string | undefined {
  for (const part of node.namedChildren) {
    if (part?.type !== "string_content") return undefined;
  }
  const raw = node.text;
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  const stripped = raw.slice(1, -1);
  // Double quotes keep escape removal, so only contents spelled literally are accepted.
  return /\\[$`"\\\n]/.test(stripped) ? undefined : stripped;
}
