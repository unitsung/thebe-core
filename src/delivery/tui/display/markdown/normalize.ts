import { parseBareUrl, parseImageAt, parseLinkAt, fenceMarker, isEscaped, runLength, type Fence } from "./parser.ts";

export function normalizeMarkdownForTui(source: string): string {
  const lines = source.split("\n");
  let fence: Fence | undefined;
  return lines.map((line) => {
    const marker = fenceMarker(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.character === fence.character && marker.length >= fence.length) fence = undefined;
      return line;
    }
    if (fence || /^\s{4}|\t/.test(line)) return line;
    return replaceImagesAndUrlsOutsideInlineCode(line);
  }).join("\n");
}

export const normalizeMarkdownImages = normalizeMarkdownForTui;

function replaceImagesAndUrlsOutsideInlineCode(line: string): string {
  let result = "";
  let cursor = 0;
  let inlineCodeLength: number | undefined;
  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const length = runLength(line, cursor, "`");
      result += line.slice(cursor, cursor + length);
      inlineCodeLength = inlineCodeLength === undefined ? length : inlineCodeLength === length ? undefined : inlineCodeLength;
      cursor += length;
      continue;
    }
    if (inlineCodeLength === undefined && line.startsWith("![", cursor) && !isEscaped(line, cursor)) {
      const image = parseImageAt(line, cursor);
      if (image) {
        result += `[🖼 ${image.alt.trim() || "image"}](${image.url})`;
        cursor = image.end;
        continue;
      }
    }
    if (inlineCodeLength === undefined && line[cursor] === "[") {
      const link = parseLinkAt(line, cursor);
      if (link) {
        result += line.slice(cursor, link.end);
        cursor = link.end;
        continue;
      }
    }
    if (inlineCodeLength === undefined && (line.startsWith("https://", cursor) || line.startsWith("http://", cursor))) {
      const url = parseBareUrl(line, cursor);
      if (url) {
        result += `[${url.value}](${url.value})`;
        cursor = url.end;
        continue;
      }
    }
    result += line[cursor];
    cursor += 1;
  }
  return result;
}
