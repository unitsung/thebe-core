/**
 * Default themes from pi-tui `test/test-themes.ts` (v0.85.0).
 */
import { Chalk } from "chalk";
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import type { ThinkingLevel } from "../runtime/types.ts";

const chalk = new Chalk({ level: 3 });

export const defaultSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.blue(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) => chalk.dim(text),
  noMatch: (text: string) => chalk.dim(text),
};

export const defaultMarkdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.cyan(text),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => chalk.green(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

export const lightSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.blue(text),
  selectedText: (text: string) => chalk.bold.black(text),
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) => chalk.dim(text),
  noMatch: (text: string) => chalk.dim(text),
};

export const lightMarkdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.blue(text),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.magenta(text),
  codeBlock: (text: string) => chalk.black(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.blue(text),
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
  theme: ThemeName = "dark",
): (text: string) => string {
  switch (level) {
    case "off":
      return theme === "light" ? lightEditorTheme.borderColor : defaultEditorTheme.borderColor;
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
      return theme === "light" ? lightEditorTheme.borderColor : defaultEditorTheme.borderColor;
  }
}

export function getBashModeBorderColor(_theme: ThemeName = "dark"): (text: string) => string {
  return greenBorder;
}

export function getRunningBorderColor(_theme: ThemeName = "dark"): (text: string) => string {
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

