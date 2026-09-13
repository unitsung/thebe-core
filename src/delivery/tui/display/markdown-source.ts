import type { Markdown } from "../rendering/adapter.ts";

const sources = new WeakMap<object, string>();

export function stashMarkdownSource(md: Markdown, text: string): void {
  sources.set(md, text);
}

export function readMarkdownSource(md: Markdown): string {
  return sources.get(md) ?? "";
}
