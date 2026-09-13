import { Markdown, type MarkdownTheme } from "../rendering/adapter.ts";
import { highlightCode } from "../rendering/adapter.ts";
import { stashMarkdownSource } from "../display/markdown-source.ts";
import { normalizeMarkdownForTui } from "../display/markdown/normalize.ts";

export function makeReplyMarkdown(text: string, theme: MarkdownTheme): Markdown {
  const markdown = new Markdown(normalizeMarkdownForTui(text), 1, 1, {
    ...theme,
    highlightCode: (code, language) => highlightCode(code, language),
  });
  stashMarkdownSource(markdown, text);
  return markdown;
}
