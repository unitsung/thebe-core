import type { SlashHost } from "./context.ts";
import { SLASH_COMMANDS, type SlashCategory } from "../slash.ts";

export function handleHelpCommand(host: SlashHost, name: string): boolean {
  const { tui, notice, insertBeforeFooter, makeMarkdown } = host;
  if (name === "help") {
    const categories: SlashCategory[] = [
      "Session",
      "Agent",
      "Provider",
      "System",
      "Thebe",
    ];
    const lines = ["Thebe Commands:"];
    for (const category of categories) {
      const group = SLASH_COMMANDS.filter((c) => c.category === category);
      if (group.length === 0) continue;
      lines.push("", category);
      for (const c of group) {
        const alias =
          c.aliases && c.aliases.length > 0
            ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})`
            : "";
        lines.push(
          `  /${c.name.padEnd(12)} ${c.argumentHint ?? ""} — ${c.description ?? ""}${alias}`,
        );
      }
    }
    notice(lines.join("\n"));
    return true;
  }
  if (name === "hotkeys") {
    const hotkeysMarkdown = [
      "## Keyboard Shortcuts",
      "",
      "**Navigation**",
      "| Key | Action |",
      "|-----|--------|",
      "| `Up` / `Down` / `Left` / `Right` | Move cursor / browse history |",
      "| `Alt+Left` / `Alt+Right` | Move by word |",
      "| `Home` / `Ctrl+A` | Start of line |",
      "| `End` / `Ctrl+E` | End of line |",
      "| `PageUp` / `PageDown` | Scroll by page |",
      "",
      "**Editing**",
      "| Key | Action |",
      "|-----|--------|",
      "| `Enter` | Send message (steer when busy) |",
      "| `Shift+Enter` | New line |",
      "| `Alt+Backspace` | Delete word backwards |",
      "| `Alt+Delete` | Delete word forwards |",
      "| `Ctrl+U` | Delete to start of line |",
      "| `Ctrl+K` | Delete to end of line |",
      "| `Ctrl+Y` | Paste recently deleted text |",
      "| `Ctrl+Z` | Undo |",
      "",
      "**Actions & Control**",
      "| Key | Action |",
      "|-----|--------|",
      "| `Tab` | Path completion / accept autocomplete |",
      "| `Esc` | Cancel autocomplete / abort streaming / cancel bash |",
      "| `Ctrl+C` | Exit |",
      "| `Shift+Tab` | Cycle thinking level (off → min → low → med → high → xhigh → max) |",
      "| `Ctrl+L` / `Ctrl+P` | Open model selector |",
      "| `Ctrl+X` | Copy last assistant response to clipboard |",
      "| `Ctrl+T` | Hide or show reasoning blocks |",
      "| `Ctrl+O` | Expand or collapse tool output |",
      "| `Alt+Enter` / `Ctrl+Q` | Queue follow-up message |",
      "| `/` | Slash commands autocomplete (use `/help` for list) |",
      "| `!` | Run bash command (included in context) |",
      "| `!!` | Run bash command (excluded from context) |",
    ].join("\n");
    insertBeforeFooter(makeMarkdown(hotkeysMarkdown));
    tui.requestRender();
    return true;
  }
  if (name === "clear") {
    host.clearMessagesView();
    return true;
  }
  if (name === "quit" || name === "exit") {
    tui.stop();
    process.exit(0);
  }
  return false;
}
