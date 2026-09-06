/**
 * Chat shell from pi-tui `test/chat-simple.ts` (v0.85.0).
 * Thebe only replaces the fake timeout with Ask.
 */
import {
  CombinedAutocompleteProvider,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { chalk, defaultEditorTheme, defaultMarkdownTheme } from "./theme.ts";

export type ThebeTuiAsk = (text: string) => Promise<string>;

export function attachThebeChat(
  tui: TUI,
  options: { ask: ThebeTuiAsk },
): { editor: Editor } {
  tui.addChild(
    new Text(
      "Thebe — four read-only container tools.\n\nType a question. Type '/' for commands. Ctrl+C to exit.",
    ),
  );

  const editor = new Editor(tui, defaultEditorTheme);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        { name: "delete", description: "Delete the last message" },
        { name: "clear", description: "Clear all messages" },
      ],
      process.cwd(),
    ),
  );
  tui.addChild(editor);
  tui.setFocus(editor);

  let isResponding = false;
  editor.onSubmit = (value: string) => {
    if (isResponding) {
      return;
    }
    const trimmed = value.trim();
    const children = tui.children;

    if (trimmed === "/delete") {
      if (children.length > 2) {
        children.splice(children.length - 2, 1);
      }
      tui.requestRender();
      return;
    }
    if (trimmed === "/clear") {
      children.splice(1, children.length - 2);
      tui.requestRender();
      return;
    }
    if (!trimmed) {
      return;
    }

    isResponding = true;
    editor.disableSubmit = true;
    children.splice(
      children.length - 1,
      0,
      new Markdown(value, 1, 1, defaultMarkdownTheme),
    );
    const loader = new Loader(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.dim(s),
      "Thinking...",
    );
    children.splice(children.length - 1, 0, loader);
    tui.requestRender();

    void options
      .ask(trimmed)
      .then((reply) => {
        tui.removeChild(loader);
        loader.stop();
        children.splice(
          children.length - 1,
          0,
          new Markdown(reply, 1, 1, defaultMarkdownTheme),
        );
      })
      .catch((error: unknown) => {
        tui.removeChild(loader);
        loader.stop();
        children.splice(
          children.length - 1,
          0,
          new Text(error instanceof Error ? error.message : String(error)),
        );
      })
      .finally(() => {
        isResponding = false;
        editor.disableSubmit = false;
        tui.requestRender();
      });
  };

  return { editor };
}

export function startThebeTui(options: { ask: ThebeTuiAsk }): TUI {
  const tui: TUI = new TuiMainScreen(new ProcessTerminal());
  attachThebeChat(tui, options);
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      tui.stop();
      process.exit(0);
    }
    return undefined;
  });
  tui.start();
  return tui;
}
