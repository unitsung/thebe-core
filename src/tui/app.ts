/**
 * TUI public surface. Implementation lives in focused modules under src/tui/.
 */
export type { ThebeTuiSend, ThebeTuiOptions } from "./types.ts";
export type { SlashCategory, ThebeSlashCommand } from "./slash.ts";
export {
  SLASH_COMMANDS,
  resolveSlashName,
  THINKING_DESCRIPTIONS,
} from "./slash.ts";
export {
  formatTokens,
  formatCwd,
  formatCwdForFooter,
  formatSessionTree,
} from "./display/format.ts";
export { copyToClipboard, openBrowser } from "./display/clipboard.ts";
export { attachPromptInput, attachSelectList } from "./overlays/index.ts";
export { parseModelRef, resolveListedProvider } from "./overlays/model-ref.ts";
export { attachThebeChat, startThebeTui, type ChatHandle } from "./chat.ts";
