import { describe, expect, it } from "vitest";
import { dispatchSlash } from "./dispatch.ts";
import { SLASH_COMMANDS, slashCommandsForAutocomplete } from "./registry.ts";

describe("slash command menu", () => {
  it("keeps common commands in a stable, task-first menu order", () => {
    const commands = slashCommandsForAutocomplete();
    expect(commands.map((command) => command.name)).toEqual([
      "help",
      "new",
      "resume",
      "model",
      "agents",
      "thinking",
      "goal",
      "compact",
      "summary",
      "history",
      "clear",
      "revert",
      "fork",
      "tree",
      "session",
      "export",
      "copy",
      "name",
      "delete",
      "settings",
      "permissions",
      "config",
      "hotkeys",
      "login",
      "logout",
      "skills",
      "mcp",
      "subagent",
      "quit",
    ]);
    expect(commands.every((command) => !("argumentHint" in command))).toBe(true);
    expect(commands.find((command) => command.name === "fork")?.description).toBe(
      "Create a new conversation branch from a user turn",
    );
    expect(commands.find((command) => command.name === "mcp")?.description).toBe(
      "Browse configured MCP servers and tools",
    );
    expect(commands.find((command) => command.name === "permissions")?.description).toBe(
      "Choose whether risky tools ask before running",
    );
    expect(SLASH_COMMANDS.slice(-4, -1).map((command) => command.name)).toEqual([
      "skills",
      "mcp",
      "subagent",
    ]);
  });

  it("passes explicit Pi skill invocations through to the runtime", async () => {
    const handled = await dispatchSlash({} as never, "/skill:demo check");
    expect(handled).toBe(false);
  });
});
