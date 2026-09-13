import { Input, type TUI } from "../rendering/adapter.ts";
import { chalk } from "../theme.ts";
import { insertOverlay, type DismissibleOverlay } from "./base.ts";

export function attachPromptInput(
  tui: TUI,
  options: { prompt: string; placeholder?: string; focusBack?: unknown; abortSignal?: AbortSignal },
): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const input = new Input({
      prompt: options.prompt,
      placeholder: options.placeholder ?? "",
      placeholderStyle: (text) => chalk.dim(text),
    });
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(input);
      if (options.focusBack) tui.setFocus(options.focusBack as never);
      tui.requestRender();
      resolvePromise(value);
    };
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        finish(null);
        return;
      }
      options.abortSignal.addEventListener("abort", () => finish(null), { once: true });
    }
    (input as unknown as DismissibleOverlay).dismiss = () => finish(null);
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);
    const originalHandleInput = input.handleInput.bind(input);
    input.handleInput = (keyData) => {
      originalHandleInput(keyData);
      tui.requestRender();
    };
    insertOverlay(tui, input, options.focusBack);
    tui.setFocus(input);
    tui.requestRender();
  });
}
