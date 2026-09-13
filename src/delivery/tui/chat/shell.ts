import {
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  matchesKey,
  type TUI,
} from "../rendering/adapter.ts";
import type { ThebeTuiOptions } from "../types.ts";
import { attachThebeChat, type ChatHandle } from "./controller.ts";

/** Owns terminal construction and renderer handoff; chat lifecycle stays in the controller seam. */
export function startThebeTui(options: ThebeTuiOptions): TUI {
  let mode = options.tuiMode ?? "regular";
  const terminal = new ProcessTerminal();
  let tui: TUI | undefined;
  let activeChat: ChatHandle | undefined;
  let activeSessionId = options.sessionId;
  let activeSessionTitle = options.title;
  let activeModel = options.model;

  const launch = (): TUI => {
    tui = mode === "fullscreen" ? new TuiAltScreen(terminal, true) : new TuiMainScreen(terminal);
    tui.setClearOnShrink(true);
    let chat!: ChatHandle;
    chat = attachThebeChat(tui, {
      ...options,
      sessionId: activeSessionId,
      title: activeSessionTitle,
      model: activeModel,
      tuiMode: mode,
      onTuiModeChange: async (next) => {
        if (next === mode) return;
        const current = chat?.getSessionState();
        activeSessionId = current?.sessionId ?? activeSessionId;
        activeSessionTitle = current?.title ?? activeSessionTitle;
        activeModel = current?.model ?? activeModel;
        chat?.dispose();
        const previousTui = tui;
        mode = next;
        options.tuiMode = next;
        options.sessionId = activeSessionId;
        options.title = activeSessionTitle;
        options.model = activeModel;
        previousTui?.stop({ preserveScreen: true });
        const nextTui = launch();
        nextTui.start();
      },
    });
    activeChat = chat;
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        tui?.stop();
        if (options.agent) {
          const force = setTimeout(() => process.exit(0), 1_000);
          force.unref?.();
          void options.agent.quiesce().catch(() => {}).finally(() => {
            clearTimeout(force);
            process.exit(0);
          });
          return { consume: true };
        }
        process.exit(0);
      }
      if (matchesKey(data, "ctrl+t")) {
        chat.toggleThinking();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+o")) {
        chat.toggleTools();
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        if (chat.isExecutingBash()) {
          chat.abortBash();
          return { consume: true };
        }
        if (chat.isResponding() && options.agent) {
          const id = activeChat?.getSessionState().sessionId ?? activeSessionId ?? options.agent.lastThebeSessionId();
          if (id) void options.agent.interrupt(id).catch(() => {});
          return { consume: true };
        }
      }
      return undefined;
    });
    return tui;
  };

  const started = launch();
  started.start();
  return started;
}
