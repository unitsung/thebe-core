#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  TOKEN_SCOPES,
  createDeviceToken,
  describeTokenScopes,
  readDeviceTokens,
  readTokenUsage,
  revokeAllDeviceTokens,
  revokeDeviceToken,
  revokeToken,
  rotateToken,
  tokenFilePath,
  tokenStatus,
} from "../http/token-store.ts";

const HELP = `thebe token <command>

  create <name> [--scope mcp:read|mcp:write]
                  make a token for one device or agent; shown once, only its hash is kept.
                  With --scope the token works only on /mcp: mcp:read for read tools,
                  mcp:write for write tools too. Without it the token has full access.
  list            the device tokens: name, scope, created, last used
  revoke <name>   remove one device's token; the others keep working
  revoke --all    remove every device token and close the shared one
  status          where the shared token comes from and when it last changed
  show            print the shared token (a terminal only)
  rotate          replace the shared token; the old one stops working at once

Give an agent that connects over /mcp its own scoped token, and send it as
"Authorization: Bearer <token>" (or X-Thebe-Token).

The shared token is the one Core made on first start (or THEBE_TOKEN). Device tokens are extra:
give each device its own, and revoke only that one if it is lost.

Run it on the machine where Core runs, with the same THEBE_CONFIG_DIR. A token set through
THEBE_TOKEN belongs to your environment and is not changed here.`;

/** `create` takes the device name as the words that are left once `--scope <value>` is taken out. */
function parseCreateArgs(
  args: readonly string[]
):
  | { ok: true; name: string; scope?: (typeof TOKEN_SCOPES)[number] }
  | { ok: false; problem: string } {
  const words: string[] = [];
  let scope: (typeof TOKEN_SCOPES)[number] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--scope" && !arg.startsWith("--scope=")) {
      words.push(arg);
      continue;
    }
    const value = arg === "--scope" ? args[++i] : arg.slice("--scope=".length);
    const known = TOKEN_SCOPES.find((candidate) => candidate === value);
    if (!known) {
      return {
        ok: false,
        problem: `--scope takes ${TOKEN_SCOPES.join(" or ")}.`,
      };
    }
    if (scope) return { ok: false, problem: "Give --scope once." };
    scope = known;
  }
  return { ok: true, name: words.join(" "), scope };
}

export function runTokenCommand(
  argv: readonly string[],
  configDir: string,
  io: {
    log(line: string): void;
    error(line: string): void;
    env?: NodeJS.ProcessEnv;
  }
): number {
  const [command] = argv;
  const env = io.env;
  switch (command) {
    case "status": {
      const status = tokenStatus({ configDir, env });
      if (status.managedBy === "env")
        io.log("token: set by THEBE_TOKEN (not changed by this command)");
      else if (status.managedBy === "none")
        io.log(
          `token: none yet (${status.path}); Core makes one on first start`
        );
      else
        io.log(
          `token: ${status.path}, changed ${status.modifiedAt?.toISOString()}`
        );
      return 0;
    }
    case "show": {
      const status = tokenStatus({ configDir, env });
      if (status.managedBy !== "file") {
        io.error(
          status.managedBy === "env"
            ? "The token is set by THEBE_TOKEN."
            : "There is no token file yet."
        );
        return 1;
      }
      io.log(readFileSync(tokenFilePath(configDir), "utf8").trim());
      return 0;
    }
    case "create": {
      const parsed = parseCreateArgs(argv.slice(1));
      if (!parsed.ok) {
        io.error(parsed.problem);
        return 2;
      }
      const result = createDeviceToken({
        configDir,
        name: parsed.name,
        scope: parsed.scope,
      });
      if (!result.ok) {
        io.error(
          result.reason === "exists"
            ? "A device token with that name already exists."
            : result.reason === "reserved-name"
              ? "That name is reserved; pick another."
              : result.reason === "store-unreadable"
                ? "tokens.json could not be read; it was left untouched. Fix or move it, then try again."
                : "Name the device in 1-40 letters, digits, spaces, dots, dashes or underscores."
        );
        return 1;
      }
      io.log(result.token);
      io.error(
        `Token for "${result.name}" created. It is shown only now; paste it into that device.`
      );
      return 0;
    }
    case "list": {
      const devices = readDeviceTokens(configDir);
      const usage = readTokenUsage(configDir);
      if (!devices.length) io.log("no device tokens");
      for (const device of devices) {
        io.log(
          `${device.name}\tscope ${describeTokenScopes(device.scopes)}\tcreated ${device.createdAt}\tlast used ${usage[device.name] ?? "never"}`
        );
      }
      return 0;
    }
    case "rotate": {
      const result = rotateToken({ configDir, env });
      if (!result.ok) {
        io.error(
          "The token is set by THEBE_TOKEN; change it in your environment instead."
        );
        return 1;
      }
      io.log(result.token);
      io.error(
        "New token written. The old one no longer works; paste this one into each device."
      );
      return 0;
    }
    case "revoke": {
      const target = argv.slice(1).join(" ").trim();
      if (!target) {
        io.error(
          "Say which: `thebe token revoke <name>` or `thebe token revoke --all`."
        );
        return 2;
      }
      if (target === "--all") {
        const removed = revokeAllDeviceTokens(configDir);
        const shared = revokeToken({ configDir, env });
        io.error(
          `Removed ${removed} device token(s)` +
            (shared.ok
              ? " and closed the shared token."
              : "; the shared token is set by THEBE_TOKEN and was left.")
        );
        return 0;
      }
      if (!revokeDeviceToken({ configDir, name: target })) {
        io.error(
          `No device token named "${target}". See \`thebe token list\`.`
        );
        return 1;
      }
      io.error(`Revoked "${target}". The other tokens still work.`);
      return 0;
    }
    default:
      (command ? io.error : io.log)(HELP);
      return command ? 2 : 0;
  }
}

const isMain =
  process.argv[1]?.endsWith("token.js") ||
  process.argv[1]?.endsWith("token.ts");
if (isMain) {
  const configDir = resolve(
    process.env.THEBE_CONFIG_DIR ?? join(process.env.HOME ?? ".", ".thebe")
  );
  process.exit(
    runTokenCommand(process.argv.slice(2), configDir, {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    })
  );
}
