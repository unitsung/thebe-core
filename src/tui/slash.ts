import type { SlashCommand } from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../runtime/types.ts";

export type SlashCategory = "Session" | "Agent" | "Provider" | "System" | "Thebe";

export type ThebeSlashCommand = SlashCommand & {
  category: SlashCategory;
  aliases?: string[];
};

/**
 * Canonical slash commands.
 *
 * Keep the palette ordered by how often commands are used. Session navigation
 * and model controls come first, diagnostics and configuration follow, and
 * Thebe-specific integrations stay at the end.
 */
export const SLASH_COMMANDS: ThebeSlashCommand[] = [
  { name: "help", category: "System", description: "Show all commands grouped by purpose" },
  { name: "new", category: "Session", description: "Start a fresh conversation" },
  { name: "resume", category: "Session", aliases: ["sessions", "continue"], description: "Browse and switch to a saved conversation" },
  { name: "model", category: "Agent", aliases: ["models", "mo"], description: "Choose the model for the current conversation" },
  { name: "agents", category: "Agent", aliases: ["agent"], description: "View active agents and their status" },
  { name: "thinking", category: "Agent", description: "Set the reasoning depth for the current conversation" },
  { name: "compact", category: "Session", aliases: ["summarize"], description: "Compact the current context immediately" },
  { name: "summary", category: "Session", description: "View the latest automatic task summary" },
  { name: "history", category: "Session", aliases: ["messages", "message"], description: "Inspect current conversation messages without switching sessions" },
  { name: "clear", category: "Session", description: "Clear the visible conversation view" },
  { name: "revert", category: "Session", aliases: ["undo"], description: "Revert the latest user turn" },
  { name: "fork", category: "Session", description: "Create a new conversation branch from a user turn" },
  { name: "tree", category: "Session", description: "Browse and switch between conversation branches" },
  { name: "session", category: "Session", aliases: ["usage", "status"], description: "Show current session details and token usage" },
  { name: "export", category: "Session", description: "Save the current conversation as HTML and JSONL" },
  { name: "copy", category: "Session", description: "Copy the latest assistant response" },
  { name: "name", category: "Session", aliases: ["rename"], description: "Rename the current conversation" },
  { name: "delete", category: "Session", description: "Delete a saved conversation and its transcript" },
  { name: "settings", category: "System", description: "Open interactive Thebe settings" },
  { name: "permissions", category: "System", aliases: ["permission", "access"], description: "Choose whether risky tools ask before running" },
  { name: "config", category: "System", description: "Open the user configuration file" },
  { name: "hotkeys", category: "System", description: "Show keyboard shortcuts" },
  { name: "login", category: "Provider", aliases: ["connect"], description: "Connect a model provider" },
  { name: "logout", category: "Provider", description: "Disconnect a model provider" },
  { name: "skills", category: "Thebe", aliases: ["skill"], description: "Browse and manage installed skills" },
  { name: "mcp", category: "Thebe", description: "Browse configured MCP servers and tools" },
  { name: "subagent", category: "Thebe", aliases: ["subagents"], description: "Run isolated one-shot subagents" },
  { name: "quit", category: "System", aliases: ["exit", "q"], description: "Exit Thebe" },
];

const SLASH_ALIAS_TO_NAME = new Map<string, string>();
for (const command of SLASH_COMMANDS) {
  for (const alias of command.aliases ?? []) {
    SLASH_ALIAS_TO_NAME.set(alias, command.name);
  }
}

const EXTRA_SLASH_ALIASES = new Map<string, string>([
  ["fork", "fork"],
  ["tree", "tree"],
  ["interrupt", "interrupt"],
  ["allow", "allow"],
  ["deny", "deny"],
  ["provider", "provider"],
  ["sessions", "resume"],
  ["messages", "history"],
  ["message", "history"],
  ["usage", "session"],
  ["status", "session"],
  ["agent", "agents"],
  ["followup", "followup"],
  ["unrevert", "unrevert"],
  ["custom", "custom"],
  ["endpoint", "custom"],
  ["proxy", "custom"],
  ["skill", "skills"],
  ["subagents", "subagent"],
  ["theme", "theme"],
  ["themes", "theme"],
  ["tui", "tui"],
]);

export function resolveSlashName(name: string): string {
  return SLASH_ALIAS_TO_NAME.get(name) ?? EXTRA_SLASH_ALIASES.get(name) ?? name;
}

export function slashCommandsForAutocomplete(): SlashCommand[] {
  return SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
  }));
}

export const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};
