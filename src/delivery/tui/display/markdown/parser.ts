export type ParsedDestination = { url: string; end: number };
export type Fence = { character: "`" | "~"; length: number };

export function parseImageAt(source: string, start: number): (ParsedDestination & { alt: string }) | undefined {
  if (!source.startsWith("![", start)) return undefined;
  const closeLabel = findUnescaped(source, "]", start + 2);
  if (closeLabel < 0 || source[closeLabel + 1] !== "(") return undefined;
  const destination = parseDestination(source, closeLabel + 1);
  return destination ? { alt: source.slice(start + 2, closeLabel), url: destination.url, end: destination.end } : undefined;
}

export function parseLinkAt(source: string, start: number): (ParsedDestination & { label: string }) | undefined {
  if (source[start] !== "[") return undefined;
  const closeLabel = findUnescaped(source, "]", start + 1);
  if (closeLabel < 0 || source[closeLabel + 1] !== "(") return undefined;
  const destination = parseDestination(source, closeLabel + 1);
  return destination ? { label: source.slice(start + 1, closeLabel), url: destination.url, end: destination.end } : undefined;
}

function parseDestination(source: string, openParen: number): ParsedDestination | undefined {
  let cursor = openParen + 1;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  let url: string;
  if (source[cursor] === "<") {
    const closeAngle = findUnescaped(source, ">", cursor + 1);
    if (closeAngle < 0) return undefined;
    url = source.slice(cursor + 1, closeAngle);
    cursor = closeAngle + 1;
  } else {
    const urlStart = cursor;
    while (cursor < source.length && !/[\s)]/.test(source[cursor] ?? "")) cursor += 1;
    url = source.slice(urlStart, cursor);
  }
  if (!url) return undefined;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] === ")") return { url: unescapeMarkdown(url), end: cursor + 1 };
  const closeParen = findUnescaped(source, ")", cursor);
  return closeParen < 0 ? undefined : { url: unescapeMarkdown(url), end: closeParen + 1 };
}

export function parseBareUrl(source: string, start: number): { value: string; end: number } | undefined {
  const match = /^https?:\/\/[^\s<>]+/.exec(source.slice(start));
  if (!match) return undefined;
  let value = match[0];
  while (/[.,;:!?]$/.test(value)) value = value.slice(0, -1);
  while (value.endsWith(")") && unmatchedClosingParentheses(value)) value = value.slice(0, -1);
  return value ? { value, end: start + value.length } : undefined;
}

export function fenceMarker(line: string): Fence | undefined {
  const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  return marker ? { character: marker[0] as "`" | "~", length: marker.length } : undefined;
}

export function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

export function runLength(source: string, start: number, character: string): number {
  let length = 0;
  while (source[start + length] === character) length += 1;
  return length;
}

function findUnescaped(source: string, character: string, start: number): number {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === character && !isEscaped(source, cursor)) return cursor;
  }
  return -1;
}

function unmatchedClosingParentheses(value: string): boolean {
  let balance = 0;
  for (const character of value) {
    if (character === "(") balance += 1;
    if (character === ")") balance -= 1;
  }
  return balance < 0;
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\()<>])/g, "$1");
}
