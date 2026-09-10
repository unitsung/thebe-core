/**
 * Official Pi UI helpers that Thebe is allowed to reuse.
 *
 * Product and TUI code must import these from here — never from
 * `@earendil-works/pi-coding-agent` directly (see CONTEXT.md isolation).
 *
 * Only symbols on the package public export surface are re-exported.
 */
import {
  BashExecutionComponent,
  copyToClipboard,
  createLocalBashOperations,
  getMarkdownTheme,
  getSelectListTheme,
  getSettingsListTheme,
  highlightCode,
  initTheme,
  renderDiff,
  Theme,
  ThemeSelectorComponent,
  ToolExecutionComponent,
  type ToolExecutionOptions,
} from "@earendil-works/pi-coding-agent";

const themeCache = new Map<string, Theme>();

export function getPiThemeInstance(name: string = "dark"): Theme {
  const normalized = name === "light" ? "light" : "dark";
  let cached = themeCache.get(normalized);
  if (!cached) {
    const sym = Symbol.for("@earendil-works/pi-coding-agent:theme");
    const current = (globalThis as Record<symbol, unknown>)[sym];
    initTheme(normalized, false);
    cached = (globalThis as Record<symbol, unknown>)[sym] as Theme;
    themeCache.set(normalized, cached);
    if (current) {
      (globalThis as Record<symbol, unknown>)[sym] = current;
    }
  }
  return cached;
}

export {
  BashExecutionComponent,
  copyToClipboard,
  createLocalBashOperations,
  getMarkdownTheme,
  getSelectListTheme,
  getSettingsListTheme,
  highlightCode,
  initTheme,
  renderDiff,
  Theme,
  ThemeSelectorComponent,
  ToolExecutionComponent,
  type ToolExecutionOptions,
};
