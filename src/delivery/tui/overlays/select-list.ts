import {
  SelectList,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "../rendering/adapter.ts";
import { defaultSelectListTheme } from "../theme.ts";
import { insertOverlay, type DismissibleOverlay } from "./base.ts";

export function attachSelectList(
  tui: TUI,
  items: SelectItem[],
  focusBack?: unknown,
  onSelectionChange?: (item: SelectItem) => void,
  theme?: SelectListTheme,
): Promise<SelectItem | null> {
  return new Promise((resolvePromise) => {
    let resolved = false;
    let list: SelectList;
    const finish = (value: SelectItem | null) => {
      if (resolved) return;
      resolved = true;
      tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
      resolvePromise(value);
    };
    list = new SelectList(items, Math.min(items.length + 2, 10), theme ?? defaultSelectListTheme);
    const originalHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => { originalHandleInput(keyData); tui.requestRender(); };
    if (onSelectionChange) list.onSelectionChange = onSelectionChange;
    list.onSelect = finish;
    list.onCancel = () => finish(null);
    (list as unknown as DismissibleOverlay).dismiss = () => finish(null);
    insertOverlay(tui, list, focusBack);
    tui.setFocus(list);
    tui.requestRender();
  });
}

export function attachModalSelectList(
  tui: TUI,
  items: SelectItem[],
  focusBack?: unknown,
  onSelectionChange?: (item: SelectItem) => void,
  theme?: SelectListTheme,
): Promise<SelectItem | null> {
  return new Promise((resolvePromise) => {
    let resolved = false;
    let list: SelectList;
    let handle: ReturnType<TUI["showOverlay"]> | undefined;
    const finish = (value: SelectItem | null) => {
      if (resolved) return;
      resolved = true;
      handle?.hide();
      if (!handle) tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
      resolvePromise(value);
    };
    list = new SelectList(items, Math.min(items.length + 2, 10), theme ?? defaultSelectListTheme);
    const originalHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => { originalHandleInput(keyData); tui.requestRender(); };
    if (onSelectionChange) list.onSelectionChange = onSelectionChange;
    list.onSelect = (item) => finish(item);
    list.onCancel = () => finish(null);
    (list as unknown as DismissibleOverlay).dismiss = () => finish(null);
    handle = tui.showOverlay(list, { width: "90%", maxHeight: "50%", anchor: "center" });
    tui.requestRender();
  });
}
