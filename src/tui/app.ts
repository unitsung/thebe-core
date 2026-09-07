/**
 * Thebe terminal UI on @earendil-works/pi-tui.
 * Session workflows go through ThebeProduct (same path as HTTP/CLI).
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CombinedAutocompleteProvider,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  matchesKey,
  type SelectItem,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../product/service.ts";
import type {
  NormalizedEvent,
  ThinkingLevel,
} from "../runtime/types.ts";
import {
  chalk,
  defaultEditorTheme,
  defaultMarkdownTheme,
  defaultSelectListTheme,
} from "./theme.ts";

export type ThebeTuiSend = (text: string) => Promise<string>;

export type ThebeTuiOptions = {
  product?: ThebeProduct;
  sessionId?: string;
  title?: string;
  /** Simple reply adapter used by unit tests / demos. */
  send?: ThebeTuiSend;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Resume a session", argumentHint: "<id>" },
  { name: "session", description: "Show current session info" },
  { name: "name", description: "Set session title", argumentHint: "<title>" },
  { name: "fork", description: "Fork session", argumentHint: "[messageId]" },
  { name: "compact", description: "Compact context" },
  { name: "export", description: "Export session", argumentHint: "[file]" },
  { name: "model", description: "List or set model", argumentHint: "[provider/id]" },
  { name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
  { name: "followup", description: "Queue a follow-up", argumentHint: "<text>" },
  { name: "interrupt", description: "Abort the current run" },
  { name: "revert", description: "Revert last user turn (history only)" },
  { name: "unrevert", description: "Undo the last revert" },
  { name: "messages", description: "Show session messages" },
  { name: "sessions", description: "List product sessions" },
  { name: "allow", description: "Allow pending tool permission", argumentHint: "[id]" },
  { name: "deny", description: "Deny pending tool permission", argumentHint: "[id]" },
  { name: "clear", description: "Clear the visible transcript" },
  { name: "delete", description: "Delete the last visible message" },
  { name: "quit", description: "Quit Thebe" },
  { name: "help", description: "Show slash commands" },
];

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function attachThebeChat(
  tui: TUI,
  options: ThebeTuiOptions,
): { editor: Editor } {
  const product = options.product;
  let sessionId = options.sessionId;

  tui.addChild(
    new Text(
      [
        "Thebe — product TUI on pi-tui (AgentRuntime embed, not Pi CLI).",
        "Type a prompt. `/` for commands. Enter while running steers; Alt+Enter queues follow-up; Esc interrupts.",
        "",
      ].join("\n"),
    ),
  );

  const editor = new Editor(tui, defaultEditorTheme);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()),
  );
  tui.addChild(editor);
  tui.setFocus(editor);

  let isResponding = false;
  let streamUnsub: (() => void) | undefined;
  let replyMarkdown: Markdown | undefined;
  let loader: Loader | undefined;
  let pendingPermissionId: string | undefined;

  const children = tui.children;

  function notice(text: string): void {
    children.splice(children.length - 1, 0, new Text(chalk.dim(text)));
    tui.requestRender();
  }

  function insertBeforeEditor(component: { render(width: number): string[] }): void {
    children.splice(children.length - 1, 0, component as never);
    tui.requestRender();
  }

  function ensureSession(): string {
    if (!sessionId) {
      throw new Error("no active session; use /new");
    }
    return sessionId;
  }

  function beginStream(label = "Thinking..."): void {
    replyMarkdown = new Markdown("", 1, 1, defaultMarkdownTheme);
    insertBeforeEditor(replyMarkdown);
    loader = new Loader(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.dim(s),
      label,
    );
    insertBeforeEditor(loader);
  }

  function endStream(): void {
    if (loader) {
      tui.removeChild(loader);
      loader.stop();
      loader = undefined;
    }
    streamUnsub?.();
    streamUnsub = undefined;
    replyMarkdown = undefined;
  }

  function onEvent(event: NormalizedEvent): void {
    if (event.type === "text_delta" && replyMarkdown) {
      const current = (replyMarkdown as unknown as { text?: string }).text;
      // Markdown stores source privately; rebuild by replacing the component.
      const next = `${readMarkdownSource(replyMarkdown)}${event.text}`;
      const index = children.indexOf(replyMarkdown);
      if (index >= 0) {
        const replacement = new Markdown(next, 1, 1, defaultMarkdownTheme);
        children[index] = replacement;
        replyMarkdown = replacement;
        stashMarkdownSource(replacement, next);
        tui.requestRender();
      }
      void current;
    } else if (event.type === "tool_start") {
      notice(`tool ${event.toolName}…`);
    } else if (event.type === "tool_end") {
      notice(
        `tool ${event.toolName}: ${event.isError ? "error" : "ok"}`,
      );
    } else if (event.type === "permission_requested") {
      pendingPermissionId = event.permissionId;
      notice(
        `permission ${event.permissionId}: ${event.toolName} (${event.risk ?? "standard"}) ${event.argsSummary ?? ""} — /allow or /deny`,
      );
    } else if (event.type === "interrupted") {
      notice("interrupted");
    } else if (event.type === "error") {
      notice(`error: ${event.message}`);
    } else if (event.type === "queue_update") {
      notice(
        `queue steering=${event.steering} followUp=${event.followUp}`,
      );
    }
  }

  async function runPrompt(
    text: string,
    mode: "prompt" | "steer" | "followUp" = "prompt",
  ): Promise<void> {
    if (!product) {
      if (!options.send) {
        throw new Error("TUI requires product or send");
      }
      isResponding = true;
      editor.disableSubmit = true;
      insertBeforeEditor(new Markdown(text, 1, 1, defaultMarkdownTheme));
      beginStream();
      try {
        const reply = await options.send(text);
        if (replyMarkdown) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = new Markdown(reply, 1, 1, defaultMarkdownTheme);
          }
        }
      } finally {
        endStream();
        isResponding = false;
        editor.disableSubmit = false;
        tui.requestRender();
      }
      return;
    }

    const id = ensureSession();
    if (mode === "prompt") {
      if (isResponding) {
        // Default Enter while busy = steer (Pi parity).
        await product.prompt(text, { thebeSessionId: id, mode: "steer" });
        notice(`steered: ${text}`);
        return;
      }
      isResponding = true;
      // Keep submit enabled so Enter can queue steer mid-run.
      insertBeforeEditor(new Markdown(text, 1, 1, defaultMarkdownTheme));
      beginStream();
      stashMarkdownSource(replyMarkdown!, "");
      streamUnsub = product.subscribeLog(id, onEvent);
      try {
        const result = await product.prompt(text, {
          thebeSessionId: id,
          mode: "prompt",
        });
        if (replyMarkdown && !readMarkdownSource(replyMarkdown)) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = new Markdown(
              result.text,
              1,
              1,
              defaultMarkdownTheme,
            );
          }
        }
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
      } finally {
        endStream();
        isResponding = false;
        tui.requestRender();
      }
      return;
    }

    await product.prompt(text, { thebeSessionId: id, mode });
    notice(`${mode}: ${text}`);
  }

  async function handleSlash(raw: string): Promise<boolean> {
    if (!raw.startsWith("/")) {
      return false;
    }
    const body = raw.slice(1).trim();
    const space = body.indexOf(" ");
    const name = (space < 0 ? body : body.slice(0, space)).toLowerCase();
    const arg = space < 0 ? "" : body.slice(space + 1).trim();

    if (name === "help") {
      notice(
        SLASH_COMMANDS.map((c) => `/${c.name} — ${c.description ?? ""}`).join(
          "\n",
        ),
      );
      return true;
    }
    if (name === "clear") {
      children.splice(1, children.length - 2);
      tui.requestRender();
      return true;
    }
    if (name === "delete") {
      if (children.length > 2) {
        children.splice(children.length - 2, 1);
      }
      tui.requestRender();
      return true;
    }
    if (name === "quit" || name === "exit") {
      tui.stop();
      process.exit(0);
    }

    if (!product) {
      notice("slash session commands need a product-backed TUI");
      return true;
    }

    try {
      switch (name) {
        case "new": {
          const meta = await product.createSession({
            title: arg || options.title,
          });
          sessionId = meta.thebeSessionId;
          notice(`new session ${sessionId}`);
          break;
        }
        case "resume": {
          if (!arg) {
            notice("usage: /resume <id>");
            break;
          }
          const meta = await product.resume(arg);
          sessionId = meta.thebeSessionId;
          notice(`resumed ${sessionId}`);
          break;
        }
        case "session": {
          const id = sessionId ?? product.lastThebeSessionId();
          if (!id) {
            notice("no active session");
            break;
          }
          const meta = await product.getSession(id);
          notice(
            [
              `thebeSessionId: ${meta.thebeSessionId}`,
              `runtimeSessionId: ${meta.runtimeSessionId}`,
              `title: ${meta.title ?? "-"}`,
              `parent: ${meta.parentThebeSessionId ?? "-"}`,
              `updated: ${meta.lastActiveAt ?? meta.updatedAt ?? "-"}`,
            ].join("\n"),
          );
          break;
        }
        case "name": {
          const id = ensureSession();
          if (!arg) {
            notice("usage: /name <title>");
            break;
          }
          await product.patchSession(id, { title: arg });
          notice(`titled ${arg}`);
          break;
        }
        case "fork": {
          const meta = await product.fork(sessionId, arg || undefined);
          sessionId = meta.thebeSessionId;
          notice(`forked ${sessionId}`);
          break;
        }
        case "compact": {
          await product.compact(sessionId);
          notice("compacted");
          break;
        }
        case "export": {
          const exported = await product.exportSession(sessionId);
          if (arg) {
            const base = resolve(arg);
            const jsonlPath = base.endsWith(".jsonl")
              ? base
              : base.endsWith(".html")
                ? base.replace(/\.html$/, ".jsonl")
                : `${base}.jsonl`;
            const htmlPath = base.endsWith(".html")
              ? base
              : base.endsWith(".jsonl")
                ? base.replace(/\.jsonl$/, ".html")
                : `${base}.html`;
            await writeFile(jsonlPath, exported.jsonl, "utf8");
            await writeFile(htmlPath, exported.html, "utf8");
            notice(`exported ${jsonlPath} and ${htmlPath}`);
          } else {
            notice(
              `export ready (${exported.jsonl.length} jsonl bytes, ${exported.html.length} html bytes); pass a path to write`,
            );
          }
          break;
        }
        case "model": {
          if (!arg) {
            const models = await product.listAvailableModels();
            notice(
              models
                .slice(0, 40)
                .map((m) => `${m.providerId}/${m.modelId}`)
                .join("\n") || "(no models)",
            );
            break;
          }
          const slash = arg.indexOf("/");
          if (slash <= 0) {
            notice("usage: /model provider/modelId");
            break;
          }
          const id = ensureSession();
          await product.setModel(id, {
            providerId: arg.slice(0, slash),
            modelId: arg.slice(slash + 1),
          });
          notice(`model ${arg}`);
          break;
        }
        case "thinking": {
          if (!THINKING_LEVELS.has(arg as ThinkingLevel)) {
            notice("usage: /thinking off|minimal|low|medium|high|xhigh|max");
            break;
          }
          const id = ensureSession();
          await product.setThinkingLevel(id, arg as ThinkingLevel);
          notice(`thinking ${arg}`);
          break;
        }
        case "followup": {
          if (!arg) {
            notice("usage: /followup <text>");
            break;
          }
          const id = ensureSession();
          await product.prompt(arg, { thebeSessionId: id, mode: "followUp" });
          notice(`follow-up: ${arg}`);
          break;
        }
        case "interrupt": {
          await product.interrupt(sessionId);
          notice("interrupt requested");
          break;
        }
        case "revert": {
          await product.revert(sessionId);
          notice("reverted (history only; side effects remain)");
          break;
        }
        case "unrevert": {
          await product.unrevert(sessionId);
          notice("unreverted");
          break;
        }
        case "messages": {
          const id = ensureSession();
          const messages = await product.loadMessages(id);
          notice(
            messages
              .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
              .join("\n") || "(empty)",
          );
          break;
        }
        case "sessions": {
          const rows = await product.listSessions();
          notice(
            rows
              .map(
                (r) =>
                  `${r.thebeSessionId.slice(0, 8)}…  ${r.status}  ${r.title ?? "-"}`,
              )
              .join("\n") || "(no sessions)",
          );
          break;
        }
        case "allow":
        case "deny": {
          const id = ensureSession();
          const permissionId =
            arg ||
            pendingPermissionId ||
            product.pendingPermissionIds().at(-1);
          if (!permissionId) {
            notice("no pending permission");
            break;
          }
          await product.resolvePermission(id, permissionId, {
            response: name === "allow" ? "allow" : "deny",
          });
          if (pendingPermissionId === permissionId) {
            pendingPermissionId = undefined;
          }
          notice(`${name} ${permissionId}`);
          break;
        }
        default:
          notice(`unknown command /${name}; try /help`);
      }
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  editor.onSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    // Keep UI-only slash commands synchronous for tests and snappy UX.
    if (trimmed === "/clear") {
      children.splice(1, children.length - 2);
      tui.requestRender();
      return;
    }
    if (trimmed === "/delete") {
      if (children.length > 2) {
        children.splice(children.length - 2, 1);
      }
      tui.requestRender();
      return;
    }
    void (async () => {
      if (await handleSlash(trimmed)) {
        return;
      }
      try {
        await runPrompt(trimmed, "prompt");
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
        isResponding = false;
        editor.disableSubmit = false;
        endStream();
      }
    })();
  };

  // Alt+Enter → follow-up while a run is active (best-effort; terminals vary).
  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (isResponding && matchesKey(data, "alt+enter")) {
      const trimmed = editor.getText().trim();
      if (trimmed && product && sessionId) {
        void product
          .prompt(trimmed, { thebeSessionId: sessionId, mode: "followUp" })
          .then(() => {
            notice(`follow-up: ${trimmed}`);
            editor.setText("");
          })
          .catch((error: unknown) =>
            notice(error instanceof Error ? error.message : String(error)),
          );
        return;
      }
    }
    originalHandleInput(data);
  };

  return { editor };
}

export function startThebeTui(options: ThebeTuiOptions): TUI {
  const tui: TUI = new TuiMainScreen(new ProcessTerminal());
  const { editor } = attachThebeChat(tui, options);
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      tui.stop();
      process.exit(0);
    }
    if (matchesKey(data, "escape") && options.product) {
      const id = options.sessionId ?? options.product.lastThebeSessionId();
      if (id) {
        void options.product.interrupt(id).catch(() => {});
      }
      return { consume: true };
    }
    void editor;
    return undefined;
  });
  tui.start();
  return tui;
}

/** SelectList helper for future pickers (models / sessions). */
export function attachSelectList(
  tui: TUI,
  items: SelectItem[],
): Promise<SelectItem | null> {
  return new Promise((resolvePromise) => {
    const list = new SelectList(items, 8, defaultSelectListTheme);
    list.onSelect = (item) => {
      tui.removeChild(list);
      resolvePromise(item);
    };
    list.onCancel = () => {
      tui.removeChild(list);
      resolvePromise(null);
    };
    tui.addChild(list);
    tui.setFocus(list);
    tui.requestRender();
  });
}

const markdownSources = new WeakMap<object, string>();

function stashMarkdownSource(md: Markdown, text: string): void {
  markdownSources.set(md, text);
}

function readMarkdownSource(md: Markdown): string {
  return markdownSources.get(md) ?? "";
}
