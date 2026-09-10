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
 * Names, aliases, and descriptions match official Pi builtin slash commands.
 * Thebe-only entries live in the Thebe category (skills / mcp / subagent).
 */
export const SLASH_COMMANDS: ThebeSlashCommand[] = [
  // Session
  { name: "resume", category: "Session", aliases: ["sessions", "continue"], description: "Resume a different session", argumentHint: "[query]" },
  { name: "new", category: "Session", description: "Start a new session", argumentHint: "[title]" },
  { name: "session", category: "Session", aliases: ["usage", "status"], description: "Show session info and token usage statistics" },
  { name: "tree", category: "Session", description: "Navigate session tree (switch branches)" },
  { name: "fork", category: "Session", description: "Create a new fork from a previous user message", argumentHint: "[messageId]" },
  { name: "name", category: "Session", aliases: ["rename"], description: "Set session display name", argumentHint: "<title>" },
  { name: "compact", category: "Session", aliases: ["summarize"], description: "Manually compact the session context", argumentHint: "[prompt]" },
  { name: "export", category: "Session", description: "Export session (HTML default, or specify path: .html/.jsonl)", argumentHint: "[path]" },
  { name: "copy", category: "Session", description: "Copy last agent message to clipboard" },
  { name: "revert", category: "Session", aliases: ["undo"], description: "Revert last user turn" },
  { name: "clear", category: "Session", description: "Clear the visible transcript" },
  // Agent / Model / Thinking
  { name: "model", category: "Agent", aliases: ["models", "mo"], description: "Select model (opens selector UI)", argumentHint: "[provider/model]" },
  { name: "thinking", category: "Agent", description: "Set thinking level", argumentHint: "[level]" },
  { name: "agents", category: "Agent", aliases: ["agent"], description: "List all active agents and their status" },
  // Provider / Auth
  { name: "login", category: "Provider", aliases: ["connect"], description: "Configure provider authentication", argumentHint: "[provider]" },
  { name: "logout", category: "Provider", description: "Remove provider authentication", argumentHint: "[provider]" },
  // System
  { name: "settings", category: "System", description: "Open settings menu" },
  { name: "theme", category: "System", aliases: ["themes"], description: "Switch theme", argumentHint: "[dark|light]" },
  { name: "tui", category: "System", description: "regular or fullscreen viewport", argumentHint: "[regular|fullscreen]" },
  { name: "hotkeys", category: "System", description: "Show all keyboard shortcuts" },
  { name: "help", category: "System", description: "Show commands by category" },
  { name: "quit", category: "System", aliases: ["exit", "q"], description: "Quit Thebe" },
  // Thebe
  { name: "skills", category: "Thebe", aliases: ["skill"], description: "Discover, inspect, and enable/disable skills", argumentHint: "[list|enable|disable] [name]" },
  { name: "mcp", category: "Thebe", description: "Inspect Core MCP tools and configured servers", argumentHint: "[list|call|servers] [tool] [argsJson]" },
  { name: "subagent", category: "Thebe", aliases: ["subagents"], description: "List, inspect, and spawn subagent profiles", argumentHint: "[list|spawn|profiles] [profile] [task]" },
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
]);

export function resolveSlashName(name: string): string {
  return SLASH_ALIAS_TO_NAME.get(name) ?? EXTRA_SLASH_ALIASES.get(name) ?? name;
}

export function slashCommandsForAutocomplete(): SlashCommand[] {
  return SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
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
