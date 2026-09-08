#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "./bootstrap.ts";
import { parseCliArgs } from "./cli/args.ts";
import { runCliCommand } from "./cli/commands.ts";
import { startThebeTui } from "./tui/app.ts";
import { loadThebeConfig } from "./tui/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const command = parseCliArgs(process.argv.slice(2));

if (command.kind === "help") {
  const { CLI_HELP } = await import("./cli/args.ts");
  console.log(CLI_HELP.trimEnd());
  process.exit(0);
}

if (command.kind === "error") {
  console.error(command.message);
  console.error("Try `thebe --help`.");
  process.exit(2);
}

if (command.kind === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  const { CLI_HELP } = await import("./cli/args.ts");
  console.log(CLI_HELP.trimEnd());
  process.exit(0);
}

const { product } = await bootstrapThebe({ fromDir: here });

const userConfig = await loadThebeConfig();
const resolvedTuiMode =
  command.kind === "tui" && command.tuiMode
    ? command.tuiMode
    : userConfig.tuiMode ?? "regular";

const code = await runCliCommand(product, command, {
  startTui: ({ product: p, sessionId, title }) => {
    startThebeTui({
      product: p,
      sessionId,
      title,
      model:
        command.kind === "tui" && command.model
          ? `${command.model.providerId}/${command.model.modelId}`
          : "opencode/muse-spark-1.3-free",
      tuiMode: resolvedTuiMode,
    });
  },
});

if (command.kind !== "tui") {
  process.exit(code);
}
