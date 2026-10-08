import type { CliCommand, CliModel } from "./types.ts";

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
  model: CliModel | undefined | "invalid",
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

function parseModel(value: string | undefined): CliModel | undefined | "invalid" {
  if (!value) {
    return undefined;
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
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
