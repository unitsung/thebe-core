/**
 * TUI delivery Interface. Implementation lives under src/delivery/tui/.
 */
export type { ThebeTuiSend, ThebeTuiOptions } from "./types.ts";
export type { SlashCategory, ThebeSlashCommand } from "./commands/registry.ts";
export {
  SLASH_COMMANDS,
  resolveSlashName,
  THINKING_DESCRIPTIONS,
} from "./commands/registry.ts";
export {
  formatTokens,
  formatCwd,
  formatCwdForFooter,
  formatSessionTree,
  renderStartScreen,
} from "./display/format.ts";
export { copyToClipboard, openBrowser } from "./display/clipboard.ts";
export { attachPromptInput, attachSelectList } from "./overlays/index.ts";
export { parseModelRef, resolveListedProvider } from "./overlays/model-ref.ts";
export { attachThebeChat, type ChatHandle } from "./chat/controller.ts";
export { startThebeTui } from "./chat/shell.ts";
