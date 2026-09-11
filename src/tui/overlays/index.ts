import {
  Input,
  SelectList,
  SettingsList,
  type SelectItem,
  type SettingItem,
  type SettingsListTheme,
  type TUI,
  type TuiMode,
} from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../../runtime/types.ts";
import { chalk, defaultSelectListTheme, type ThemeName } from "../theme.ts";
import { THINKING_LEVELS } from "../slash.ts";

export function insertOverlay(tui: TUI, component: unknown, focusBack?: unknown): void {
  const idx = focusBack ? tui.children.indexOf(focusBack as never) : -1;
  if (idx >= 0) {
    tui.children.splice(idx, 0, component as never);
  } else {
    tui.addChild(component as never);
  }
}

export function attachPromptInput(
  tui: TUI,
  options: {
    prompt: string;
    placeholder?: string;
    focusBack?: unknown;
    abortSignal?: AbortSignal;
  },
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const input = new Input({
      prompt: options.prompt,
      placeholder: options.placeholder ?? "",
      placeholderStyle: (text) => chalk.dim(text),
    });
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(input);
      if (options.focusBack) {
        tui.setFocus(options.focusBack as never);
      }
      tui.requestRender();
      resolvePromise(value);
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        finish(null);
        return;
      }
      options.abortSignal.addEventListener("abort", () => finish(null), { once: true });
    }
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);
    const origHandleInput = input.handleInput.bind(input);
    input.handleInput = (keyData) => {
      origHandleInput(keyData);
      tui.requestRender();
    };
    insertOverlay(tui, input, options.focusBack);
    tui.setFocus(input);
    tui.requestRender();
  });
}

const defaultSettingsListTheme: SettingsListTheme = {
  label: (text, selected) => (selected ? chalk.bold.cyan(text) : text),
  value: (text, selected) => (selected ? chalk.cyan(text) : chalk.dim(text)),
  description: (text) => chalk.dim(text),
  cursor: "→ ",
  hint: (text) => chalk.dim(text),
};

const lightSettingsListTheme: SettingsListTheme = {
  label: (text, selected) => (selected ? chalk.bold.blue(text) : chalk.black(text)),
  value: (text, selected) => (selected ? chalk.blue(text) : chalk.dim(text)),
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
    autoCompact?: boolean;
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
    const items: SettingItem[] = [
      {
        id: "theme",
        label: "Theme",
        description: "TUI color theme (applied immediately)",
        currentValue: options.theme,
        values: ["dark", "light"],
      },
      {
        id: "thinking",
        label: "Thinking",
        description: "Reasoning level for the current session",
        currentValue: options.thinking,
        values: Array.from(THINKING_LEVELS),
      },
      {
        id: "tui",
        label: "TUI mode",
        description: "regular scrolling terminal or fullscreen viewport",
        currentValue: options.tuiMode,
        values: ["regular", "fullscreen"],
      },
      {
        id: "autoCompact",
        label: "Auto-compact",
        description: "Automatically compact context when threshold reached",
        currentValue: String(options.autoCompact ?? true),
        values: ["true", "false"],
      },
      {
        id: "steeringMode",
        label: "Steering mode",
        description: "Message delivery mode when steering agent",
        currentValue: options.steeringMode ?? "one-at-a-time",
        values: ["one-at-a-time", "all"],
      },
      {
        id: "followUpMode",
        label: "Follow-up mode",
        description: "Follow-up queue processing mode",
        currentValue: options.followUpMode ?? "one-at-a-time",
        values: ["one-at-a-time", "all"],
      },
      {
        id: "hideThinking",
        label: "Hide thinking",
        description: "Collapse or hide thinking process blocks in chat",
        currentValue: String(options.hideThinking ?? true),
        values: ["false", "true"],
      },
      {
        id: "quietStartup",
        label: "Quiet startup",
        description: "Suppress banner and tips on launch",
        currentValue: String(options.quietStartup ?? false),
        values: ["false", "true"],
      },
      {
        id: "fullscreenExitOutput",
        label: "Exit output",
        description: "What to print when exiting fullscreen TUI",
        currentValue: options.fullscreenExitOutput ?? "transcript",
        values: ["transcript", "resume-hint"],
      },
      {
        id: "fullscreenScrollbar",
        label: "Scrollbar",
        description: "Scrollbar display in fullscreen mode",
        currentValue: options.fullscreenScrollbar ?? "auto",
        values: ["auto", "always", "hidden"],
      },
    ];
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 14),
      options.theme === "light" ? lightSettingsListTheme : defaultSettingsListTheme,
      (id, newValue) => {
        list.updateValue(id, newValue);
        tui.requestRender();
        void options.onSettingChange(id, newValue);
      },
      () => {
        tui.removeChild(list);
        if (focusBack) tui.setFocus(focusBack as never);
        tui.requestRender();
        resolvePromise();
      },
    );
    const origHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => {
      origHandleInput(keyData);
      tui.requestRender();
    };
    insertOverlay(tui, list, focusBack);
    tui.setFocus(list);
    tui.requestRender();
  });
}

export function attachSelectList(
  tui: TUI,
  items: SelectItem[],
  focusBack?: { focus?: () => void } | unknown,
  onSelectionChange?: (item: SelectItem) => void,
  theme?: import("@earendil-works/pi-tui").SelectListTheme,
): Promise<SelectItem | null> {
  return new Promise((resolvePromise) => {
    const list = new SelectList(
      items,
      Math.min(items.length + 2, 10),
      theme ?? defaultSelectListTheme,
    );
    const origHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => {
      origHandleInput(keyData);
      tui.requestRender();
    };
    if (onSelectionChange) {
      list.onSelectionChange = onSelectionChange;
    }
    list.onSelect = (item) => {
      tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
      resolvePromise(item);
    };
    list.onCancel = () => {
      tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
      resolvePromise(null);
    };
    insertOverlay(tui, list, focusBack);
    tui.setFocus(list);
    tui.requestRender();
  });
}
