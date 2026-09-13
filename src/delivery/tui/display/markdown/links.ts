import { getCapabilities, hyperlink, wrapTextWithAnsi } from "../../rendering/adapter.ts";
import { chalk } from "../../theme.ts";
import { fenceMarker, isEscaped, parseBareUrl, parseImageAt, parseLinkAt, runLength, type Fence } from "./parser.ts";

export function wrapTerminalLinks(value: string, width: number, style: (text: string) => string): string[] {
  const rendered: string[] = [];
  let fence: Fence | undefined;
  for (const line of value.split(/\r?\n/)) {
    const marker = fenceMarker(line);
    if (marker) {
      rendered.push(...wrapTextWithAnsi(style(line || " "), width));
      if (!fence) fence = marker;
      else if (marker.character === fence.character && marker.length >= fence.length) fence = undefined;
      continue;
    }
    rendered.push(...wrapTextWithAnsi(fence ? style(line || " ") : renderInlineLinks(line || " ", style), width));
  }
  return rendered;
}

function renderInlineLinks(line: string, style: (text: string) => string): string {
  let result = "";
  let plain = "";
  let cursor = 0;
  let inlineCodeLength: number | undefined;
  const flushPlain = () => {
    if (plain) {
      result += style(plain);
      plain = "";
    }
  };
  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const length = runLength(line, cursor, "`");
      plain += line.slice(cursor, cursor + length);
      inlineCodeLength = inlineCodeLength === undefined ? length : inlineCodeLength === length ? undefined : inlineCodeLength;
      cursor += length;
      continue;
    }
    if (inlineCodeLength === undefined && !isEscaped(line, cursor)) {
      const image = line.startsWith("![", cursor) ? parseImageAt(line, cursor) : undefined;
      if (image) {
        flushPlain();
        result += externalLink(`🖼 ${image.alt.trim() || "image"}`, image.url);
        cursor = image.end;
        continue;
      }
      const link = line[cursor] === "[" ? parseLinkAt(line, cursor) : undefined;
      if (link) {
        flushPlain();
        result += externalLink(link.label, link.url);
        cursor = link.end;
        continue;
      }
      if (line.startsWith("https://", cursor) || line.startsWith("http://", cursor)) {
        const url = parseBareUrl(line, cursor);
        if (url) {
          flushPlain();
          result += externalLink(url.value, url.value);
          cursor = url.end;
          continue;
        }
      }
    }
    plain += line[cursor];
    cursor += 1;
  }
  flushPlain();
  return result;
}

function externalLink(label: string, url: string): string {
  const styledLabel = chalk.cyan(chalk.underline(label));
  return getCapabilities().hyperlinks ? hyperlink(styledLabel, url) : `${styledLabel}${chalk.dim(` (${url})`)}`;
}
