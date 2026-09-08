/**
 * Minimal argv parser for the Thebe CLI. Thin product front-end — not a
 * parallel agent suite and never shells out to the Pi CLI.
 */

export type CliCommand =
  | { kind: "help" }
  | {
      kind: "tui";
      sessionId?: string;
      continueLast?: boolean;
      title?: string;
      model?: { providerId: string; modelId: string };
      tuiMode?: "regular" | "fullscreen";
    }
  | {
      kind: "print";
      text: string;
      sessionId?: string;
      continueLast?: boolean;
      title?: string;
      model?: { providerId: string; modelId: string };
      thinking?: string;
      mode?: "prompt" | "steer" | "followUp";
    }
  | { kind: "list-models"; providerId?: string; all?: boolean; search?: string }
  | { kind: "session-list" }
  | { kind: "session-create"; title?: string; model?: { providerId: string; modelId: string } }
  | { kind: "session-resume"; sessionId: string }
  | { kind: "session-fork"; sessionId?: string; atEntryId?: string }
  | { kind: "session-compact"; sessionId?: string }
  | {
      kind: "session-export";
      sessionId?: string;
      format: "jsonl" | "html" | "both";
      out?: string;
    }
  | { kind: "session-delete"; sessionId: string }
  | { kind: "session-messages"; sessionId?: string }
  | { kind: "session-status" }
  | { kind: "session-interrupt"; sessionId?: string }
  | { kind: "session-revert"; sessionId?: string }
  | { kind: "session-unrevert"; sessionId?: string }
  | {
      kind: "session-model";
      sessionId: string;
      model: { providerId: string; modelId: string };
    }
  | { kind: "session-thinking"; sessionId: string; level: string }
  | { kind: "error"; message: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.slice();
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-") && takesValue(key)) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2) {
      const key = shortToLong(arg[1]!);
      if (!key) {
        return { kind: "error", message: `unknown flag: ${arg}` };
      }
      const next = args[i + 1];
      if (next && !next.startsWith("-") && takesValue(key)) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positionals.push(arg);
  }

  if (flags.has("help") || flags.has("h")) {
    return { kind: "help" };
  }

  const model = parseModel(flagString(flags, "model"));
  const thinking = flagString(flags, "thinking");
  const title = flagString(flags, "name") ?? flagString(flags, "title");
  const sessionId =
    flagString(flags, "session") ?? flagString(flags, "resume");
  const continueLast = flags.has("continue");
  const modeFlag = flagString(flags, "mode");
  const mode =
    modeFlag === "steer" || modeFlag === "followUp" || modeFlag === "prompt"
      ? modeFlag
      : undefined;

  const tuiModeFlag = flagString(flags, "tui-mode");
  if (tuiModeFlag && tuiModeFlag !== "regular" && tuiModeFlag !== "fullscreen") {
    return {
      kind: "error",
      message: `invalid --tui-mode: "${tuiModeFlag}"; want "regular" or "fullscreen"`,
    };
  }
  const tuiMode: "regular" | "fullscreen" | undefined =
    tuiModeFlag === "regular" || tuiModeFlag === "fullscreen"
      ? tuiModeFlag
      : flags.has("fullscreen")
        ? "fullscreen"
        : flags.has("regular")
          ? "regular"
          : undefined;

  if (flags.has("list-models")) {
    const search =
      typeof flags.get("list-models") === "string"
        ? String(flags.get("list-models"))
        : positionals[0];
    return {
      kind: "list-models",
      providerId: flagString(flags, "provider"),
      all: flags.has("all"),
      search,
    };
  }

  const head = positionals[0];
  if (head === "help") {
    return { kind: "help" };
  }
  if (head === "tui") {
    if (model === "invalid") {
      return {
        kind: "error",
        message: "invalid --model; want provider/modelId",
      };
    }
    return { kind: "tui", sessionId, continueLast, title, model, tuiMode };
  }
  if (head === "session") {
    return parseSessionSubcommand(positionals.slice(1), flags, model);
  }
  if (head === "model" && positionals[1] === "list") {
    return {
      kind: "list-models",
      providerId: flagString(flags, "provider"),
      all: flags.has("all"),
      search: positionals[2],
    };
  }

  const print = flags.has("print") || flags.has("p");
  const promptText = positionals.join(" ").trim();

  if (print || promptText) {
    if (!promptText && print) {
      return { kind: "error", message: "print mode requires a prompt" };
    }
    if (model === "invalid") {
      return {
        kind: "error",
        message: "invalid --model; want provider/modelId",
      };
    }
    return {
      kind: "print",
      text: promptText,
      sessionId,
      continueLast,
      title,
      model: model === undefined ? undefined : model,
      thinking,
      mode,
    };
  }

  if (model === "invalid") {
    return {
      kind: "error",
      message: "invalid --model; want provider/modelId",
    };
  }

  return { kind: "tui", sessionId, continueLast, title, model, tuiMode };
}

function parseSessionSubcommand(
  rest: string[],
  flags: Map<string, string | true>,
  model: { providerId: string; modelId: string } | undefined | "invalid",
): CliCommand {
  const action = rest[0] ?? "list";
  const id = rest[1];
  switch (action) {
    case "list":
      return { kind: "session-list" };
    case "status":
      return { kind: "session-status" };
    case "create": {
      if (model === "invalid") {
        return {
          kind: "error",
          message: "invalid --model; want provider/modelId",
        };
      }
      {
        const title =
          flagString(flags, "name") ??
          flagString(flags, "title") ??
          (rest.slice(1).join(" ").trim() || undefined);
        return {
          kind: "session-create",
          title,
          model: model === undefined ? undefined : model,
        };
      }
    }
    case "resume":
      if (!id) {
        return { kind: "error", message: "session resume requires <id>" };
      }
      return { kind: "session-resume", sessionId: id };
    case "fork":
      return {
        kind: "session-fork",
        sessionId: id,
        atEntryId: flagString(flags, "at"),
      };
    case "compact":
      return { kind: "session-compact", sessionId: id };
    case "export": {
      const formatRaw = flagString(flags, "format") ?? "both";
      if (
        formatRaw !== "jsonl" &&
        formatRaw !== "html" &&
        formatRaw !== "both"
      ) {
        return {
          kind: "error",
          message: "invalid --format; want jsonl, html, or both",
        };
      }
      return {
        kind: "session-export",
        sessionId: id,
        format: formatRaw,
        out: flagString(flags, "out") ?? flagString(flags, "o"),
      };
    }
    case "delete":
      if (!id) {
        return { kind: "error", message: "session delete requires <id>" };
      }
      return { kind: "session-delete", sessionId: id };
    case "messages":
      return { kind: "session-messages", sessionId: id };
    case "interrupt":
      return { kind: "session-interrupt", sessionId: id };
    case "revert":
      return { kind: "session-revert", sessionId: id };
    case "unrevert":
      return { kind: "session-unrevert", sessionId: id };
    case "model": {
      if (!id) {
        return {
          kind: "error",
          message: "session model requires <id> <provider/modelId>",
        };
      }
      const ref = parseModel(rest[2] ?? flagString(flags, "model"));
      if (!ref || ref === "invalid") {
        return {
          kind: "error",
          message: "session model requires provider/modelId",
        };
      }
      return { kind: "session-model", sessionId: id, model: ref };
    }
    case "thinking": {
      if (!id || !rest[2]) {
        return {
          kind: "error",
          message: "session thinking requires <id> <level>",
        };
      }
      return {
        kind: "session-thinking",
        sessionId: id,
        level: rest[2],
      };
    }
    default:
      return {
        kind: "error",
        message: `unknown session action: ${action}`,
      };
  }
}

function parseModel(
  value: string | undefined,
): { providerId: string; modelId: string } | undefined | "invalid" {
  if (!value) {
    return undefined;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    if (
      value === "muse-spark-1.3-free" ||
      value === "muse-spark-1.3-contributor-free"
    ) {
      return {
        providerId: "opencode",
        modelId: value,
      };
    }
    return "invalid";
  }
  return {
    providerId: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

function flagString(
  flags: Map<string, string | true>,
  key: string,
): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function takesValue(key: string): boolean {
  return (
    key === "session" ||
    key === "resume" ||
    key === "model" ||
    key === "thinking" ||
    key === "name" ||
    key === "title" ||
    key === "provider" ||
    key === "format" ||
    key === "out" ||
    key === "o" ||
    key === "at" ||
    key === "mode" ||
    key === "list-models" ||
    key === "fork" ||
    key === "tui-mode"
  );
}

function shortToLong(ch: string): string | undefined {
  switch (ch) {
    case "p":
      return "print";
    case "c":
      return "continue";
    case "r":
      return "resume";
    case "h":
      return "help";
    case "n":
      return "name";
    case "o":
      return "out";
    default:
      return undefined;
  }
}

export const CLI_HELP = `thebe — headless homelab agent (product CLI over AgentRuntime)

Usage:
  thebe                          Start interactive TUI
  thebe -p "prompt"              One-shot print mode
  thebe -c                       Continue most recent session in TUI
  thebe --session <id>           Resume session in TUI
  thebe --list-models [search]   List models
  thebe session list|create|resume|fork|compact|export|delete|messages|status
  thebe session interrupt|revert|unrevert|model|thinking

Options:
  -p, --print              Print response and exit
  -c, --continue           Use most recent product session
  -r, --resume <id>        Resume session by id (alias of --session)
  --session <id>           Target session id
  --model <provider/id>    Set model before prompt
  --thinking <level>       off|minimal|low|medium|high|xhigh|max
  --mode prompt|steer|followUp
  --tui-mode <mode>        regular|fullscreen (default: regular or ~/.thebe/config.json)
  --fullscreen             Launch TUI directly in fullscreen alt-screen mode
  -n, --name <title>       Session title
  --format jsonl|html|both Export format (default both)
  -o, --out <path>         Export output path/prefix
  --provider <id>          Filter models by provider
  --all                    Include unavailable models
  -h, --help               Show help

Architecture: embeds Pi via createAgentSession / AgentRuntime. Does not spawn
the Pi CLI. Arcane, auth, ProductStore, PolicyEngine stay Thebe-owned.
`;
