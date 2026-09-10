import type { Markdown } from "@earendil-works/pi-tui";

const sources = new WeakMap<object, string>();

export function stashMarkdownSource(md: Markdown, text: string): void {
  sources.set(md, text);
}

export function readMarkdownSource(md: Markdown): string {
  return sources.get(md) ?? "";
}
