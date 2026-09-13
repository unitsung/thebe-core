import {
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
  type TUI,
  type TuiMode,
} from "../rendering/adapter.ts";
import type { ThinkingLevel } from "../../../agent/index.ts";
import { chalk, type ThemeName } from "../theme.ts";
import { THINKING_LEVELS } from "../commands/registry.ts";
import { insertOverlay, type DismissibleOverlay } from "./base.ts";

const defaultSettingsListTheme: SettingsListTheme = {
  label: (text, selected) => selected ? chalk.bold.cyan(text) : text,
  value: (text, selected) => selected ? chalk.cyan(text) : chalk.dim(text),
  description: (text) => chalk.dim(text),
  cursor: "→ ",
  hint: (text) => chalk.dim(text),
};

const lightSettingsListTheme: SettingsListTheme = {
  label: (text, selected) => selected ? chalk.bold.blue(text) : chalk.black(text),
  value: (text, selected) => selected ? chalk.blue(text) : chalk.dim(text),
  description: (text) => chalk.dim(text),
  cursor: "→ ",
  hint: (text) => chalk.dim(text),
};

export function attachSettingsMenu(
  tui: TUI,
  focusBack: unknown,
  options: {
    theme: ThemeName;
    thinking: ThinkingLevel;
    tuiMode: TuiMode;
    permissionMode?: "ask" | "read-only" | "full-access";
    autoCompact?: boolean;
    autoSummary?: boolean;
    autoSummaryDelayMs?: number;
    steeringMode?: "one-at-a-time" | "all";
    followUpMode?: "one-at-a-time" | "all";
    hideThinking?: boolean;
    quietStartup?: boolean;
    fullscreenExitOutput?: "transcript" | "resume-hint";
    fullscreenScrollbar?: "auto" | "always" | "hidden";
    onSettingChange: (id: string, value: string) => void | Promise<void>;
  },
): Promise<void> {
  return new Promise((resolvePromise) => {
    let resolved = false;
    let list: SettingsList;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
      resolvePromise();
    };
    const items: SettingItem[] = [
      { id: "theme", label: "Theme", description: "TUI color theme (applied immediately)", currentValue: options.theme, values: ["dark", "light"] },
      { id: "thinking", label: "Thinking", description: "Reasoning level for the current session", currentValue: options.thinking, values: Array.from(THINKING_LEVELS) },
      { id: "tui", label: "TUI mode", description: "regular scrolling terminal or fullscreen viewport", currentValue: options.tuiMode, values: ["regular", "fullscreen"] },
      { id: "permissionMode", label: "Permissions", description: "Ask before risky tools, or auto-approve them (not a sandbox)", currentValue: options.permissionMode ?? "ask", values: ["ask", "read-only", "full-access"] },
      { id: "autoCompact", label: "Auto-compact", description: "Automatically compact context when threshold reached", currentValue: String(options.autoCompact ?? true), values: ["true", "false"] },
      { id: "autoSummary", label: "Auto-summary", description: "Summarize a completed task after an idle delay", currentValue: String(options.autoSummary ?? true), values: ["true", "false"] },
      { id: "autoSummaryDelay", label: "Summary delay", description: "Idle seconds before generating the task summary", currentValue: `${Math.round((options.autoSummaryDelayMs ?? 120_000) / 1000)}s`, values: ["60s", "120s", "300s"] },
      { id: "steeringMode", label: "Steering mode", description: "Message delivery mode when steering agent", currentValue: options.steeringMode ?? "one-at-a-time", values: ["one-at-a-time", "all"] },
      { id: "followUpMode", label: "Follow-up mode", description: "Follow-up queue processing mode", currentValue: options.followUpMode ?? "one-at-a-time", values: ["one-at-a-time", "all"] },
      { id: "hideThinking", label: "Hide thinking", description: "Collapse or hide thinking process blocks in chat", currentValue: String(options.hideThinking ?? true), values: ["false", "true"] },
      { id: "quietStartup", label: "Quiet startup", description: "Suppress banner and tips on launch", currentValue: String(options.quietStartup ?? false), values: ["false", "true"] },
      { id: "fullscreenExitOutput", label: "Exit output", description: "What to print when exiting fullscreen TUI", currentValue: options.fullscreenExitOutput ?? "transcript", values: ["transcript", "resume-hint"] },
      { id: "fullscreenScrollbar", label: "Scrollbar", description: "Scrollbar display in fullscreen mode", currentValue: options.fullscreenScrollbar ?? "auto", values: ["auto", "always", "hidden"] },
    ];
    list = new SettingsList(items, Math.min(items.length + 2, 14), options.theme === "light" ? lightSettingsListTheme : defaultSettingsListTheme,
      (id, newValue) => {
        list.updateValue(id, newValue);
        tui.requestRender();
        void options.onSettingChange(id, newValue);
      }, finish);
    (list as unknown as DismissibleOverlay).dismiss = finish;
    const originalHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => {
      originalHandleInput(keyData);
      tui.requestRender();
    };
    insertOverlay(tui, list, focusBack);
    tui.setFocus(list);
    tui.requestRender();
  });
}
