import { matchesKey, truncateToWidth, type TUI } from "../rendering/adapter.ts";

export type DismissibleOverlay = { dismiss?: () => void };
export type DismissiblePicker = DismissibleOverlay;

export function dismissOverlay(component: unknown): void {
  const dismiss = (component as DismissibleOverlay | undefined)?.dismiss;
  dismiss?.();
}

export function insertOverlay(tui: TUI, component: unknown, focusBack?: unknown): void {
  const index = focusBack ? tui.children.indexOf(focusBack as never) : -1;
  if (index >= 0) tui.children.splice(index, 0, component as never);
  else tui.addChild(component as never);
}

export function isConfirmKey(data: string): boolean {
  return matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n";
}

export function sameProvider(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function fitLines(lines: string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width, ""));
}
