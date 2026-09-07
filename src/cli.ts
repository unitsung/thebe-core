#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "./bootstrap.ts";
import { parseCliArgs } from "./cli/args.ts";
import { runCliCommand } from "./cli/commands.ts";
import { startThebeTui } from "./tui/app.ts";

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

const { product } = await bootstrapThebe({ fromDir: here });

const code = await runCliCommand(product, command, {
  startTui: ({ product: p, sessionId, title }) => {
    startThebeTui({ product: p, sessionId, title });
  },
});
process.exit(code);
