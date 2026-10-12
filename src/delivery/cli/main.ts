#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "../../app/bootstrap.ts";
import { parseCliArgs } from "./args.ts";
import { runCliCommand } from "./commands/dispatch.ts";
import { startThebeTui } from "../tui/app.ts";
import { loadThebeConfig } from "../tui/settings/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const command = parseCliArgs(process.argv.slice(2));

if (command.kind === "help") {
  const { CLI_HELP } = await import("./args.ts");
  console.log(CLI_HELP.trimEnd());
  process.exit(0);
}

if (command.kind === "error") {
  console.error(command.message);
  console.error("Try `thebe --help`.");
  process.exit(2);
}

if (command.kind === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  const { CLI_HELP } = await import("./args.ts");
  console.log(CLI_HELP.trimEnd());
  process.exit(0);
}

if (command.kind === "doctor") {
  const { runDoctor } = await import("./commands/doctor.ts");
  process.exit(await runDoctor());
}

const { agent, workspacePath, model: bootModel } = await bootstrapThebe({ fromDir: here });

const userConfig = await loadThebeConfig();
const resolvedTuiMode =
  command.kind === "tui" && command.tuiMode
    ? command.tuiMode
    : userConfig.tuiMode ?? "regular";

const code = await runCliCommand(agent, command, {
  startTui: ({ agent: p, sessionId, title }) => {
    startThebeTui({
      agent: p,
      sessionId,
      title,
      cwd: workspacePath,
      model:
        command.kind === "tui" && command.model
          ? `${command.model.providerId}/${command.model.modelId}`
          : bootModel ? `${bootModel.providerId}/${bootModel.modelId}` : undefined,
      tuiMode: resolvedTuiMode,
    });
  },
});

if (command.kind !== "tui") {
  process.exit(code);
}
