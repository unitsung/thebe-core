/**
 * Default themes from pi-tui `test/test-themes.ts` (v0.85.0).
 */
import { Chalk } from "chalk";
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "./rendering/adapter.ts";
import type { ThinkingLevel } from "../../agent/index.ts";

const chalk = new Chalk({ level: 3 });

function renderHeading(text: string, color: (value: string) => string): string {
  const withoutMarker = text.replace(/^(\x1b\[[0-9;]*m)*#{1,6}\s+/, (match) =>
    match.replace(/#{1,6}\s+/, "")
  );
  return color(withoutMarker);
}

function renderCodeBlockBorder(text: string): string {
  const language = text.startsWith("```") ? text.slice(3).trim() : "";
  return chalk.dim(language ? `╭─ ${language} ─` : "╰─");
}

function renderListBullet(
  text: string,
  color: (value: string) => string
): string {
  return color(text.replace(/^[-+*]\s/, "• "));
}

export const defaultSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.cyan(text),
  selectedText: (text: string) => {
    const match = text.match(/^(→\s+)(\S+)(\s+)(.*)$/);
    if (match) {
      const [, arrow, name, spaces, desc] = match;
      return `${chalk.cyan(arrow)}${chalk.bold.cyan(name)}${spaces}${chalk.dim(desc)}`;
    }
    return chalk.bold.cyan(text);
  },
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) =>
    chalk.dim(`${text.trim()} · ↑↓ move · Enter select · Esc close`),
  noMatch: (_text: string) =>
    chalk.yellow(`  No matching commands · Esc to dismiss`),
};

export const defaultMarkdownTheme: MarkdownTheme = {
  heading: (text: string) =>
    renderHeading(text, (value) => chalk.bold.cyan(value)),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => chalk.green(text),
  codeBlockBorder: renderCodeBlockBorder,
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) =>
    renderListBullet(text, (value) => chalk.cyan(value)),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

export const lightSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.blue(text),
  selectedText: (text: string) => {
    const match = text.match(/^(→\s+)(\S+)(\s+)(.*)$/);
    if (match) {
      const [, arrow, name, spaces, desc] = match;
      return `${chalk.blue(arrow)}${chalk.bold.blue(name)}${spaces}${chalk.dim(desc)}`;
    }
    return chalk.bold.blue(text);
  },
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) =>
    chalk.dim(`${text.trim()} · ↑↓ move · Enter select · Esc close`),
  noMatch: (_text: string) =>
    chalk.yellow(`  No matching commands · Esc to dismiss`),
};

export const lightMarkdownTheme: MarkdownTheme = {
  heading: (text: string) =>
    renderHeading(text, (value) => chalk.bold.blue(value)),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.magenta(text),
  codeBlock: (text: string) => chalk.black(text),
  codeBlockBorder: renderCodeBlockBorder,
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) =>
    renderListBullet(text, (value) => chalk.blue(value)),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

const dimBorder = (text: string) => chalk.dim(text);
const minimalBorder = (text: string) => chalk.hex("#6e6e6e")(text);
const lowBorder = (text: string) => chalk.hex("#5f87af")(text);
const mediumBorder = (text: string) => chalk.hex("#81a2be")(text);
const highBorder = (text: string) => chalk.hex("#b294bb")(text);
const xhighBorder = (text: string) => chalk.hex("#d183e8")(text);
const maxBorder = (text: string) => chalk.hex("#ff5fff")(text);
const greenBorder = (text: string) => chalk.green(text);
const cyanBorder = (text: string) => chalk.cyan(text);

export const defaultEditorTheme: EditorTheme = {
  borderColor: dimBorder,
  selectList: defaultSelectListTheme,
};

export const lightEditorTheme: EditorTheme = {
  borderColor: dimBorder,
  selectList: lightSelectListTheme,
};

export type ThemeName = "dark" | "light";

export function getThinkingBorderColor(
  level: ThinkingLevel = "off",
  theme: ThemeName = "dark"
): (text: string) => string {
  switch (level) {
    case "off":
      return theme === "light"
        ? lightEditorTheme.borderColor
        : defaultEditorTheme.borderColor;
    case "minimal":
      return minimalBorder;
    case "low":
      return lowBorder;
    case "medium":
      return mediumBorder;
    case "high":
      return highBorder;
    case "xhigh":
      return xhighBorder;
    case "max":
      return maxBorder;
    default:
      return theme === "light"
        ? lightEditorTheme.borderColor
        : defaultEditorTheme.borderColor;
  }
}

export function getBashModeBorderColor(
  _theme: ThemeName = "dark"
): (text: string) => string {
  return greenBorder;
}

export function getRunningBorderColor(
  _theme: ThemeName = "dark"
): (text: string) => string {
  return cyanBorder;
}

export function getTuiTheme(name: ThemeName = "dark") {
  if (name === "light") {
    return {
      selectList: lightSelectListTheme,
      markdown: lightMarkdownTheme,
      editor: lightEditorTheme,
    };
  }
  return {
    selectList: defaultSelectListTheme,
    markdown: defaultMarkdownTheme,
    editor: defaultEditorTheme,
  };
}

export { chalk };
