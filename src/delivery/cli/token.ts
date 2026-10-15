#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  revokeToken,
  rotateToken,
  tokenFilePath,
  tokenStatus,
} from "../http/token-store.ts";

const HELP = `thebe token <command>

  status    where the token comes from and when it last changed
  show      print the current token (a terminal only)
  rotate    make a new token; the old one stops working at once
  revoke    close access: the token is replaced by one nobody sees
            (run \`rotate\` to open it again)

Run it on the machine where Core runs, with the same THEBE_CONFIG_DIR. A token set through
THEBE_TOKEN belongs to your environment and is not changed here.`;

export function runTokenCommand(
  argv: readonly string[],
  configDir: string,
  io: { log(line: string): void; error(line: string): void; env?: NodeJS.ProcessEnv }
): number {
  const [command] = argv;
  const env = io.env;
  switch (command) {
    case "status": {
      const status = tokenStatus({ configDir, env });
      if (status.managedBy === "env") io.log("token: set by THEBE_TOKEN (not changed by this command)");
      else if (status.managedBy === "none") io.log(`token: none yet (${status.path}); Core makes one on first start`);
      else io.log(`token: ${status.path}, changed ${status.modifiedAt?.toISOString()}`);
      return 0;
    }
    case "show": {
      const status = tokenStatus({ configDir, env });
      if (status.managedBy !== "file") {
        io.error(status.managedBy === "env" ? "The token is set by THEBE_TOKEN." : "There is no token file yet.");
        return 1;
      }
      io.log(readFileSync(tokenFilePath(configDir), "utf8").trim());
      return 0;
    }
    case "rotate":
    case "revoke": {
      const result = (command === "rotate" ? rotateToken : revokeToken)({ configDir, env });
      if (!result.ok) {
        io.error("The token is set by THEBE_TOKEN; change it in your environment instead.");
        return 1;
      }
      if (command === "rotate") {
        io.log(result.token);
        io.error("New token written. The old one no longer works; paste this one into each device.");
      } else {
        io.error("Access closed. Every client is refused until you run `thebe token rotate`.");
      }
      return 0;
    }
    default:
      (command ? io.error : io.log)(HELP);
      return command ? 2 : 0;
  }
}

const isMain = process.argv[1]?.endsWith("token.js") || process.argv[1]?.endsWith("token.ts");
if (isMain) {
  const configDir = resolve(process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe"));
  process.exit(
    runTokenCommand(process.argv.slice(2), configDir, {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    })
  );
}
