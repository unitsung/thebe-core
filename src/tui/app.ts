/**
 * Thebe terminal UI on @earendil-works/pi-tui.
 * Session workflows go through ThebeProduct (same path as HTTP/CLI).
 */
import { execSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  CombinedAutocompleteProvider,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
  type SlashCommand,
  type TUI,
  type TuiMode,
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
  lightMarkdownTheme,
  type ThemeName,
} from "./theme.ts";
import {
  attachSearchableModelPicker,
  attachSearchableProviderPicker,
} from "./model-picker.ts";
import { attachSearchableSessionPicker } from "./session-picker.ts";
import { loadThebeConfig, saveThebeConfig } from "./config.ts";

export type ThebeTuiSend = (text: string) => Promise<string>;

export type ThebeTuiOptions = {
  product?: ThebeProduct;
  sessionId?: string;
  title?: string;
  model?: string;
  version?: string;
  /** Simple reply adapter used by unit tests / demos. */
  send?: ThebeTuiSend;
  tuiMode?: TuiMode;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Search or switch model interactively or /model <query>", argumentHint: "[query]" },
  { name: "provider", description: "Browse and switch providers or filter models", argumentHint: "[provider]" },
  { name: "thinking", description: "Set thinking level (interactive if no arg)", argumentHint: "[level]" },
  { name: "settings", description: "Open interactive settings menu" },
  { name: "usage", description: "Display token and context window usage" },
  { name: "tui", description: "Switch TUI display mode: regular|fullscreen", argumentHint: "[regular|fullscreen]" },
  { name: "session", description: "Show current session info and token usage" },
  { name: "sessions", description: "Browse and search sessions (interactive picker)", argumentHint: "[query]" },
  { name: "resume", description: "Resume a session (interactive search if no id)", argumentHint: "[id|query]" },
  { name: "new", description: "Start a new session", argumentHint: "[title]" },
  { name: "name", description: "Set session title", argumentHint: "<title>" },
  { name: "fork", description: "Fork session (interactive options if no arg)", argumentHint: "[messageId]" },
  { name: "tree", description: "Display session branch tree" },
  { name: "compact", description: "Compact context" },
  { name: "export", description: "Export session to HTML and JSONL", argumentHint: "[path]" },
  { name: "theme", description: "Switch UI theme: dark|light (interactive if no arg)", argumentHint: "[dark|light]" },
  { name: "copy", description: "Copy last assistant response to clipboard" },
  { name: "hotkeys", description: "Show keyboard shortcuts and keybindings" },
  { name: "followup", description: "Queue a follow-up turn", argumentHint: "<text>" },
  { name: "interrupt", description: "Abort the current run" },
  { name: "revert", description: "Revert last user turn (history only)" },
  { name: "unrevert", description: "Undo the last revert" },
  { name: "messages", description: "Show recent session messages", argumentHint: "[limit|all]" },
  { name: "allow", description: "Allow pending tool permission", argumentHint: "[id]" },
  { name: "deny", description: "Deny pending tool permission", argumentHint: "[id]" },
  { name: "clear", description: "Clear the visible transcript" },
  { name: "quit", description: "Quit Thebe" },
  { name: "help", description: "Show slash commands and help" },
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

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatCwd(cwd: string): string {
  const home = process.env.HOME;
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

export const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

export function formatCwdForFooter(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function getGitBranch(): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export function formatSessionTree(
  sessions: Array<{
    thebeSessionId: string;
    parentThebeSessionId?: string;
    title?: string;
    status?: string;
  }>,
  currentSessionId?: string,
): string[] {
  if (sessions.length === 0) return ["(no sessions found)"];
  const byParent = new Map<string | undefined, typeof sessions>();
  for (const s of sessions) {
    const p = s.parentThebeSessionId;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(s);
  }
  const lines: string[] = ["Session Branch Tree:"];
  function printNode(id: string | undefined, prefix: string): void {
    const children = byParent.get(id) ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const isLast = i === children.length - 1;
      const marker = child.thebeSessionId === currentSessionId ? "★ " : "● ";
      const branch = isLast ? "└── " : "├── ";
      lines.push(
        `${prefix}${branch}${marker}${child.thebeSessionId.slice(0, 8)} (${child.title || "untitled"}) [${child.status ?? "idle"}]`,
      );
      printNode(child.thebeSessionId, prefix + (isLast ? "    " : "│   "));
    }
  }
  const roots = byParent.get(undefined) ?? [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    const marker = root.thebeSessionId === currentSessionId ? "★ " : "● ";
    lines.push(
      `${marker}${root.thebeSessionId.slice(0, 8)} (${root.title || "untitled"}) [${root.status ?? "idle"}]`,
    );
    printNode(root.thebeSessionId, "  ");
  }
  return lines;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    try {
      const isMac = process.platform === "darwin";
      const proc = spawn(
        isMac ? "pbcopy" : "xclip",
        isMac ? [] : ["-selection", "clipboard"],
      );
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on("close", (code) => resolveResult(code === 0));
      proc.on("error", () => resolveResult(false));
    } catch {
      resolveResult(false);
    }
  });
}

export function attachThebeChat(
  tui: TUI,
  options: ThebeTuiOptions,
): {
  editor: Editor;
  updateFooter: () => void;
  handleSlash: (raw: string) => Promise<boolean>;
  isResponding: () => boolean;
} {
  const product = options.product;
  let sessionId = options.sessionId;
  let sessionTitle = options.title;
  let currentModel = options.model ?? "opencode/muse-spark-1.3-free";
  let currentThinking: ThinkingLevel = "off";
  let currentTheme: ThemeName = "dark";
  let contextTokensUsed = 0;
  let contextWindowTotal = 1_048_576;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let activeToolName: string | undefined;
  const cachedBranch = getGitBranch();

  const appVersion = options.version ?? "0.1.0";
  tui.addChild(
    new Text(
      [
        `${chalk.bold(chalk.cyan("Thebe"))} ${chalk.dim(`v${appVersion} (connected to ${currentModel})`)}`,
        chalk.dim(
          "Enter to send · Alt+Enter to queue · Esc to interrupt · / commands · Ctrl+P model · Ctrl+C exit",
        ),
        "",
      ].join("\n"),
    ),
  );

  const footerText = new Text("");
  tui.addChild(footerText);

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

  function updateFooter(): void {
    const width = tui.terminal?.columns ?? process.stdout.columns ?? 80;
    const home = process.env.HOME || process.env.USERPROFILE;
    let pwd = formatCwdForFooter(process.cwd(), home);
    if (cachedBranch) {
      pwd = `${pwd} (${cachedBranch})`;
    }
    if (sessionTitle) {
      pwd = `${pwd} • ${sessionTitle}`;
    }

    // Line 1: PWD / Branch / Session Name
    const pwdLine = truncateToWidth(chalk.dim(pwd), width, chalk.dim("..."));

    // Line 2: Stats (left) + Model / Thinking (right)
    const statsParts: string[] = [];
    if (cumulativeInputTokens > 0) {
      statsParts.push(`↑${formatTokens(cumulativeInputTokens)}`);
    }
    if (cumulativeOutputTokens > 0) {
      statsParts.push(`↓${formatTokens(cumulativeOutputTokens)}`);
    }

    const autoIndicator = " (auto)";
    let contextPercentDisplay = "";
    if (contextWindowTotal > 0) {
      const pct = ((contextTokensUsed / contextWindowTotal) * 100).toFixed(1);
      contextPercentDisplay = `${pct}%/${formatTokens(contextWindowTotal)}${autoIndicator}`;
      if (contextTokensUsed / contextWindowTotal > 0.9) {
        statsParts.push(chalk.red(contextPercentDisplay));
      } else if (contextTokensUsed / contextWindowTotal > 0.7) {
        statsParts.push(chalk.yellow(contextPercentDisplay));
      } else {
        statsParts.push(contextPercentDisplay);
      }
    } else {
      contextPercentDisplay = `0.0%/1.0M${autoIndicator}`;
      statsParts.push(contextPercentDisplay);
    }

    const statsLeft = statsParts.join(" ");

    // Right side: (provider) modelId • thinkingLevel
    const [providerId, ...modelParts] = currentModel.includes("/")
      ? currentModel.split("/")
      : ["opencode", currentModel];
    const modelId = modelParts.join("/") || currentModel;

    let rightSideWithoutProvider = modelId;
    if (currentThinking === "off") {
      rightSideWithoutProvider = `${modelId} • thinking off`;
    } else {
      rightSideWithoutProvider = `${modelId} • ${currentThinking}`;
    }
    const rightSide = `(${providerId}) ${rightSideWithoutProvider}`;

    const minPadding = 2;
    const statsLeftWidth = visibleWidth(statsLeft);
    const rightSideWidth = visibleWidth(rightSide);
    const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

    let statsLine: string;
    if (totalNeeded <= width) {
      const padding = " ".repeat(
        Math.max(0, width - statsLeftWidth - rightSideWidth),
      );
      statsLine = chalk.dim(statsLeft) + padding + chalk.dim(rightSide);
    } else {
      const availableForRight = width - statsLeftWidth - minPadding;
      if (availableForRight > 0) {
        const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
        const padding = " ".repeat(
          Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
        );
        statsLine = chalk.dim(statsLeft) + padding + chalk.dim(truncatedRight);
      } else {
        statsLine = chalk.dim(truncateToWidth(statsLeft, width, "..."));
      }
    }

    const lines = [pwdLine, statsLine];
    if (isResponding) {
      const statusStr = activeToolName
        ? chalk.yellow(`● tool: ${activeToolName}`)
        : chalk.cyan("● thinking...");
      lines.push(statusStr);
    }

    footerText.setText(lines.join("\n"));
    tui.requestRender();
  }

  function notice(text: string): void {
    const index = children.indexOf(footerText);
    const insertAt = index >= 0 ? index : children.length - 1;
    children.splice(insertAt, 0, new Text(chalk.dim(text)));
    tui.requestRender();
  }

  function insertBeforeFooter(component: { render(width: number): string[] }): void {
    const index = children.indexOf(footerText);
    const insertAt = index >= 0 ? index : children.length - 1;
    children.splice(insertAt, 0, component as never);
    tui.requestRender();
  }

  function ensureSession(): string {
    if (!sessionId && product) {
      sessionId = product.lastThebeSessionId();
    }
    if (!sessionId) {
      throw new Error("no active session; use /new");
    }
    return sessionId;
  }

  function getActiveMarkdownTheme() {
    return currentTheme === "light" ? lightMarkdownTheme : defaultMarkdownTheme;
  }

  function beginStream(label = "Thinking..."): void {
    replyMarkdown = new Markdown("", 1, 1, getActiveMarkdownTheme());
    insertBeforeFooter(replyMarkdown);
    loader = new Loader(
      tui,
      (s) => chalk.cyan(s),
      (s) => chalk.dim(s),
      label,
    );
    insertBeforeFooter(loader);
    updateFooter();
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
    activeToolName = undefined;
    updateFooter();
  }

  function onEvent(event: NormalizedEvent): void {
    if (event.type === "text_delta" && replyMarkdown) {
      const next = `${readMarkdownSource(replyMarkdown)}${event.text}`;
      const index = children.indexOf(replyMarkdown);
      if (index >= 0) {
        const replacement = new Markdown(next, 1, 1, getActiveMarkdownTheme());
        children[index] = replacement;
        replyMarkdown = replacement;
        stashMarkdownSource(replacement, next);
        tui.requestRender();
      }
    } else if (event.type === "tool_start") {
      activeToolName = event.toolName;
      updateFooter();
      notice(`tool start: ${event.toolName}…`);
    } else if (event.type === "tool_end") {
      activeToolName = undefined;
      updateFooter();
      notice(
        `tool end: ${event.toolName} [${event.isError ? "error" : "ok"}]`,
      );
    } else if (event.type === "permission_requested") {
      pendingPermissionId = event.permissionId;
      updateFooter();
      notice(
        `permission requested: ${event.toolName} (${event.risk ?? "standard"}) ${event.argsSummary ?? ""} — use /allow or /deny`,
      );
    } else if (event.type === "interrupted") {
      notice("session interrupted");
    } else if (event.type === "error") {
      notice(`error: ${event.message}`);
    } else if (event.type === "queue_update") {
      notice(`queued: steering=${event.steering} followUp=${event.followUp}`);
    }
  }

  async function refreshContextUsage(): Promise<void> {
    if (!product || !sessionId) return;
    try {
      const usage = await product.getContextUsage(sessionId);
      const u = usage.contextUsage;
      contextTokensUsed = u.usedTokens;
      contextWindowTotal = u.maxTokens;
      updateFooter();
    } catch {
      // ignore
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
      insertBeforeFooter(new Markdown(text, 1, 1, getActiveMarkdownTheme()));
      beginStream();
      try {
        const reply = await options.send(text);
        if (replyMarkdown) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = new Markdown(reply, 1, 1, getActiveMarkdownTheme());
          }
        }
      } finally {
        endStream();
        isResponding = false;
        editor.disableSubmit = false;
        updateFooter();
        tui.requestRender();
      }
      return;
    }

    const id = ensureSession();
    if (mode === "prompt") {
      if (isResponding) {
        await product.prompt(text, { thebeSessionId: id, mode: "steer" });
        notice(`steered: ${text}`);
        return;
      }
      isResponding = true;
      insertBeforeFooter(new Markdown(text, 1, 1, getActiveMarkdownTheme()));
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
              getActiveMarkdownTheme(),
            );
          }
        }
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
      } finally {
        endStream();
        isResponding = false;
        void refreshContextUsage();
        updateFooter();
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
        [
          "Thebe Commands:",
          ...SLASH_COMMANDS.map(
            (c) => `  /${c.name.padEnd(12)} ${c.argumentHint ?? ""} — ${c.description ?? ""}`,
          ),
        ].join("\n"),
      );
      return true;
    }
    if (name === "hotkeys") {
      notice(
        [
          "Keyboard Shortcuts:",
          "  Enter          Submit prompt (or steer active turn when busy)",
          "  Alt+Enter      Queue follow-up turn mid-flight",
          "  Option+Enter   Queue follow-up turn (macOS alternative)",
          "  Esc            Interrupt current agent turn or tool execution",
          "  Ctrl+P         Quick open interactive model picker",
          "  Ctrl+C         Quit Thebe cleanly",
          "",
          "Quick Commands:",
          "  /model         Search and select model interactively or /model <query>",
          "  /provider      Browse providers and filter models or /provider <id>",
          "  /thinking      Set thinking level interactively",
          "  /sessions      Browse and search sessions interactively or /sessions <query>",
          "  /usage         Display token and context window usage stats",
          "  /tui           Switch TUI display mode (regular terminal vs fullscreen)",
          "  /settings      Interactive settings menu",
          "  /tree          Visual session branch tree",
          "  /fork          Fork session into a new branch",
          "  /copy          Copy last response to clipboard",
          "  /session       Display session info and token usage",
        ].join("\n"),
      );
      return true;
    }
    if (name === "clear") {
      const keep = new Set([children[0], footerText, editor]);
      for (let i = children.length - 1; i >= 0; i--) {
        if (!keep.has(children[i])) {
          children.splice(i, 1);
        }
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
          const defaultModelRef = {
            providerId: currentModel.includes("/") ? currentModel.split("/")[0]! : "opencode",
            modelId: currentModel.includes("/") ? currentModel.split("/").slice(1).join("/") : currentModel,
          };
          const meta = await product.createSession({
            title: arg || options.title,
            model: defaultModelRef,
          });
          sessionId = meta.thebeSessionId;
          sessionTitle = meta.title;
          void refreshContextUsage();
          updateFooter();
          notice(`new session created: ${sessionId}`);
          break;
        }
        case "resume":
        case "sessions": {
          if (name === "resume" && arg && !arg.includes(" ")) {
            const meta = await product.resume(arg);
            sessionId = meta.thebeSessionId;
            sessionTitle = meta.title;
            void refreshContextUsage();
            updateFooter();
            notice(`resumed session ${sessionId}`);
            break;
          }
          const selected = await attachSearchableSessionPicker(tui, {
            product,
            currentSessionId: sessionId,
            initialQuery: arg || undefined,
            focusBack: editor,
          });
          if (selected) {
            const meta = await product.resume(selected.thebeSessionId);
            sessionId = meta.thebeSessionId;
            sessionTitle = meta.title;
            void refreshContextUsage();
            updateFooter();
            notice(`resumed session ${sessionId} (${meta.title ?? "untitled"})`);
          }
          break;
        }
        case "usage": {
          const id = ensureSession();
          const meta = await product.getSession(id);
          let u = { usedTokens: contextTokensUsed, maxTokens: contextWindowTotal };
          let compaction: { nearThreshold: boolean; lastCompactedAt?: string } = { nearThreshold: false, lastCompactedAt: undefined };
          let estimatedCost: { amount: number; currency: string } | undefined;
          try {
            const ctx = await product.getContextUsage(id);
            u = ctx.contextUsage;
            compaction = ctx.compaction;
            estimatedCost = ctx.estimatedCost;
          } catch {}
          const msgs = await product.loadMessages(id);
          const pct = u.maxTokens > 0 ? (u.usedTokens / u.maxTokens) * 100 : 0;
          const barWidth = 24;
          const filled = Math.min(barWidth, Math.max(0, Math.round((pct / 100) * barWidth)));
          const empty = barWidth - filled;
          const meter = `[${chalk.cyan("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct.toFixed(1)}%`;
          const lines = [
            chalk.cyan("─── Token & Context Usage ──────────────────────────────────────"),
            `Session:      ${meta.thebeSessionId} (${meta.title ?? "untitled"})`,
            `Model:        ${currentModel} · Thinking: ${currentThinking}`,
            `Context Bar:  ${meter}`,
            `Context:      ${formatTokens(u.usedTokens)} / ${formatTokens(u.maxTokens)} tokens (${u.usedTokens.toLocaleString()} / ${u.maxTokens.toLocaleString()})`,
            `Cumulative:   In: ${formatTokens(cumulativeInputTokens)} · Out: ${formatTokens(cumulativeOutputTokens)}`,
            `Compaction:   Near Threshold: ${compaction.nearThreshold ? chalk.yellow("YES (approaching auto-compact)") : chalk.green("No")}${compaction.lastCompactedAt ? ` · Last: ${compaction.lastCompactedAt.slice(0, 19).replace("T", " ")}` : ""}`,
            estimatedCost ? `Cost:         $${estimatedCost.amount.toFixed(4)} ${estimatedCost.currency}` : undefined,
            `Messages:     ${msgs.length} messages in current transcript`,
            chalk.cyan("────────────────────────────────────────────────────────────────"),
          ].filter(Boolean) as string[];
          notice(lines.join("\n"));
          break;
        }
        case "tui": {
          if (arg) {
            if (arg === "fullscreen" || arg === "regular") {
              await saveThebeConfig({ tuiMode: arg });
              notice(`TUI mode set to "${arg}" (saved to ~/.thebe/config.json; active in new launch or restart)`);
            } else {
              notice("usage: /tui regular|fullscreen");
            }
            break;
          }
          const currentTuiMode = tui.mode;
          const items: SelectItem[] = [
            {
              label: `${currentTuiMode === "regular" ? "★ " : "  "}Inline Text (regular scrolling terminal text)`,
              value: "regular",
            },
            {
              label: `${currentTuiMode === "fullscreen" ? "★ " : "  "}Fullscreen (alternate screen viewport with mouse scrolling)`,
              value: "fullscreen",
            },
          ];
          const selected = await attachSelectList(tui, items, editor);
          if (selected) {
            const chosen = selected.value as "regular" | "fullscreen";
            await saveThebeConfig({ tuiMode: chosen });
            notice(
              `TUI mode configured to "${chosen}" (saved to ~/.thebe/config.json; active in next launch or restart)`,
            );
          }
          break;
        }
        case "session": {
          const id = sessionId ?? product.lastThebeSessionId();
          if (!id) {
            notice("no active session");
            break;
          }
          const meta = await product.getSession(id);
          let ctxDetails = "";
          try {
            const ctx = await product.getContextUsage(id);
            const u = ctx.contextUsage;
            ctxDetails = `context: ${formatTokens(u.usedTokens)} / ${formatTokens(u.maxTokens)} tokens (${((u.usedTokens / u.maxTokens) * 100).toFixed(1)}%)\nnear threshold: ${ctx.compaction.nearThreshold ? "yes" : "no"}`;
          } catch {
            ctxDetails = "context: stats unavailable";
          }
          notice(
            [
              `session: ${meta.thebeSessionId}`,
              `runtime session: ${meta.runtimeSessionId}`,
              `title: ${meta.title ?? "(untitled)"}`,
              `model: ${currentModel}`,
              `thinking: ${currentThinking}`,
              `parent: ${meta.parentThebeSessionId ?? "(none)"}`,
              `last active: ${meta.lastActiveAt ?? meta.updatedAt ?? "-"}`,
              ctxDetails,
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
          sessionTitle = arg;
          updateFooter();
          notice(`session title updated: "${arg}"`);
          break;
        }
        case "fork": {
          const id = ensureSession();
          if (arg) {
            const meta = await product.fork(id, arg);
            sessionId = meta.thebeSessionId;
            sessionTitle = meta.title;
            void refreshContextUsage();
            updateFooter();
            notice(`forked session ${sessionId} from message ${arg}`);
            break;
          }
          const items: SelectItem[] = [
            { label: "1. Fork from latest turn (new session)", value: "new_session" },
            { label: "2. Branch in-place (same session leaf)", value: "branch_in_place" },
          ];
          const selected = await attachSelectList(tui, items, editor);
          if (selected) {
            const meta = await product.fork(id, {
              mode: selected.value as "new_session" | "branch_in_place",
            });
            sessionId = meta.thebeSessionId;
            sessionTitle = meta.title;
            void refreshContextUsage();
            updateFooter();
            notice(`forked session ${sessionId} [mode: ${selected.value}]`);
          }

          break;
        }
        case "tree": {
          const rows = await product.listSessions();
          const lines = formatSessionTree(rows, sessionId);
          notice(lines.join("\n"));
          break;
        }
        case "compact": {
          const id = ensureSession();
          notice("compacting context...");
          await product.compact(id);
          void refreshContextUsage();
          updateFooter();
          notice("context compacted successfully");
          break;
        }
        case "export": {
          const id = ensureSession();
          const exported = await product.exportSession(id);
          const target = arg || `./thebe-export-${id.slice(0, 8)}`;
          const base = resolve(target);
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
          await mkdir(dirname(jsonlPath), { recursive: true });
          await mkdir(dirname(htmlPath), { recursive: true });
          await writeFile(jsonlPath, exported.jsonl, "utf8");
          await writeFile(htmlPath, exported.html, "utf8");
          notice(`exported session to ${jsonlPath} and ${htmlPath} (${exported.jsonl.length} jsonl bytes, ${exported.html.length} html bytes)`);
          break;
        }
        case "model": {
          const id = ensureSession();
          const available = await product.listAvailableModels();
          if (available.length === 0) {
            notice("no available models found");
            break;
          }
          if (arg) {
            const trimmed = arg.trim();
            const slash = trimmed.indexOf("/");
            const providerId = slash > 0 ? trimmed.slice(0, slash) : "opencode";
            const modelId = slash > 0 ? trimmed.slice(slash + 1) : trimmed;

            // Direct exact match check
            const exact = available.find(
              (m) =>
                `${m.providerId}/${m.modelId}`.toLowerCase() === trimmed.toLowerCase() ||
                (m.providerId.toLowerCase() === providerId.toLowerCase() &&
                  m.modelId.toLowerCase() === modelId.toLowerCase()) ||
                m.modelId.toLowerCase() === trimmed.toLowerCase(),
            );
            if (exact) {
              const newKey = `${exact.providerId}/${exact.modelId}`;
              await product.setModel(id, {
                providerId: exact.providerId,
                modelId: exact.modelId,
              });
              currentModel = newKey;
              void refreshContextUsage();
              updateFooter();
              notice(`switched model to ${currentModel} (${exact.displayName ?? exact.modelId})`);
              break;
            }
          }

          const selected = await attachSearchableModelPicker(tui, {
            product,
            currentModel,
            initialQuery: arg,
            focusBack: editor,
          });
          if (selected) {
            const newKey = `${selected.providerId}/${selected.modelId}`;
            await product.setModel(id, {
              providerId: selected.providerId,
              modelId: selected.modelId,
            });
            currentModel = newKey;
            void refreshContextUsage();
            updateFooter();
            notice(`switched model to ${currentModel} (${selected.displayName ?? selected.modelId})`);
          }
          break;
        }
        case "provider": {
          const id = ensureSession();
          if (arg) {
            const trimmed = arg.trim();
            const selected = await attachSearchableModelPicker(tui, {
              product,
              currentModel,
              providerFilter: trimmed,
              focusBack: editor,
            });
            if (selected) {
              const newKey = `${selected.providerId}/${selected.modelId}`;
              await product.setModel(id, {
                providerId: selected.providerId,
                modelId: selected.modelId,
              });
              currentModel = newKey;
              void refreshContextUsage();
              updateFooter();
              notice(`switched model to ${currentModel} (${selected.displayName ?? selected.modelId})`);
            }
            break;
          }

          const selectedProvider = await attachSearchableProviderPicker(tui, {
            product,
            currentModel,
            focusBack: editor,
          });
          if (selectedProvider) {
            const selectedModel = await attachSearchableModelPicker(tui, {
              product,
              currentModel,
              providerFilter: selectedProvider.id,
              focusBack: editor,
            });
            if (selectedModel) {
              const newKey = `${selectedModel.providerId}/${selectedModel.modelId}`;
              await product.setModel(id, {
                providerId: selectedModel.providerId,
                modelId: selectedModel.modelId,
              });
              currentModel = newKey;
              void refreshContextUsage();
              updateFooter();
              notice(`switched model to ${currentModel} (${selectedModel.displayName ?? selectedModel.modelId})`);
            }
          }
          break;
        }
        case "thinking": {
          const id = ensureSession();
          if (arg) {
            if (!THINKING_LEVELS.has(arg as ThinkingLevel)) {
              notice("usage: /thinking off|minimal|low|medium|high|xhigh|max");
              break;
            }
            await product.setThinkingLevel(id, arg as ThinkingLevel);
            currentThinking = arg as ThinkingLevel;
            updateFooter();
            notice(`thinking level set to ${arg}`);
            break;
          }
          const items: SelectItem[] = Array.from(THINKING_LEVELS).map((lvl) => {
            const isCurrent = lvl === currentThinking;
            const marker = isCurrent ? "✓ " : "  ";
            const desc = THINKING_DESCRIPTIONS[lvl] ?? "";
            const defaultBadge = lvl === "off" ? " · default" : "";
            return {
              label: `${marker}${lvl.padEnd(8)} ${desc}${defaultBadge}`,
              value: lvl,
            };
          });
          const selected = await attachSelectList(tui, items, editor);
          if (selected) {
            await product.setThinkingLevel(id, selected.value as ThinkingLevel);
            currentThinking = selected.value as ThinkingLevel;
            updateFooter();
            notice(`thinking level set to ${selected.value}`);
          }
          break;
        }
        case "settings": {
          const items: SelectItem[] = [
            { label: "1. Select Model (/model)", value: "model" },
            { label: "2. Select Provider (/provider)", value: "provider" },
            { label: "3. Set Thinking Level (/thinking)", value: "thinking" },
            { label: `4. TUI Display Mode [${tui.mode}] (/tui)`, value: "tui" },
            { label: "5. View Token & Context Usage (/usage)", value: "usage" },
            { label: `6. Switch Theme [${currentTheme}] (/theme)`, value: "theme" },
            { label: "7. Browse & Search Sessions (/sessions)", value: "sessions" },
            { label: "8. Compact Context (/compact)", value: "compact" },
            { label: "9. View Session Info (/session)", value: "session" },
            { label: "10. Keyboard Shortcuts (/hotkeys)", value: "hotkeys" },
          ];
          const selected = await attachSelectList(tui, items, editor);
          if (selected) {
            await handleSlash(`/${selected.value}`);
          }
          break;
        }
        case "theme": {
          if (arg) {
            if (arg === "dark" || arg === "light") {
              currentTheme = arg;
              notice(`theme set to ${arg}`);
            } else {
              notice("usage: /theme dark|light");
            }
            break;
          }
          const items: SelectItem[] = [
            { label: `${currentTheme === "dark" ? "★ " : "  "}Dark theme`, value: "dark" },
            { label: `${currentTheme === "light" ? "★ " : "  "}Light theme`, value: "light" },
          ];
          const selected = await attachSelectList(tui, items, editor);
          if (selected) {
            currentTheme = selected.value as ThemeName;
            notice(`theme set to ${currentTheme}`);
          }
          break;
        }
        case "copy": {
          const id = ensureSession();
          const msgs = await product.loadMessages(id);
          const assistantMsgs = msgs.filter((m) => m.role === "assistant");
          const last = assistantMsgs.at(-1);
          if (!last || !last.text) {
            notice("no assistant response found to copy");
            break;
          }
          const ok = await copyToClipboard(last.text);
          if (ok) {
            notice(`copied last response (${last.text.length} chars) to clipboard`);
          } else {
            notice(`clipboard command unavailable; response snippet: ${last.text.slice(0, 120)}...`);
          }
          break;
        }
        case "followup": {
          if (!arg) {
            notice("usage: /followup <text>");
            break;
          }
          const id = ensureSession();
          await product.prompt(arg, { thebeSessionId: id, mode: "followUp" });
          notice(`queued follow-up: ${arg}`);
          break;
        }
        case "interrupt": {
          const id = sessionId ?? product.lastThebeSessionId();
          if (id) {
            await product.interrupt(id);
            notice("interrupt requested");
          } else {
            notice("no active session to interrupt");
          }
          break;
        }
        case "revert": {
          const id = ensureSession();
          try {
            await product.revert(id);
            void refreshContextUsage();
            updateFooter();
            notice("reverted last turn (history only; external side effects remain)");
          } catch (err) {
            notice(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "unrevert": {
          const id = ensureSession();
          try {
            await product.unrevert(id);
            void refreshContextUsage();
            updateFooter();
            notice("unreverted");
          } catch (err) {
            notice(`unrevert failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "messages": {
          const id = ensureSession();
          const messages = await product.loadMessages(id);
          if (messages.length === 0) {
            notice("no messages in session");
            break;
          }
          const limit =
            arg && !isNaN(Number(arg))
              ? Number(arg)
              : arg === "all"
                ? messages.length
                : 10;
          const slice = messages.slice(-limit);
          const header =
            limit < messages.length
              ? `[Showing last ${slice.length} of ${messages.length} messages. Use /messages all or /messages <n> for more]\n`
              : `[Showing all ${messages.length} messages]\n`;
          notice(
            header +
              slice
                .map(
                  (m, i) =>
                    `${messages.length - slice.length + i + 1}. [${m.role}] ${m.text.slice(0, 240)}${m.text.length > 240 ? "..." : ""}`,
                )
                .join("\n"),
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
            notice("no pending permission to resolve");
            break;
          }
          await product.resolvePermission(id, permissionId, {
            response: name === "allow" ? "allow" : "deny",
          });
          if (pendingPermissionId === permissionId) {
            pendingPermissionId = undefined;
          }
          notice(`permission ${permissionId} ${name}ed`);
          break;
        }
        default:
          notice(`unknown command /${name}; type /help for available commands`);
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
    if (trimmed === "/clear") {
      const keep = new Set([children[0], footerText, editor]);
      for (let i = children.length - 1; i >= 0; i--) {
        if (!keep.has(children[i])) {
          children.splice(i, 1);
        }
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

  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, "ctrl+p")) {
      void handleSlash("/model");
      return;
    }
    if (isResponding && matchesKey(data, "alt+enter")) {
      const trimmed = editor.getText().trim();
      if (trimmed && product && sessionId) {
        void product
          .prompt(trimmed, { thebeSessionId: sessionId, mode: "followUp" })
          .then(() => {
            notice(`queued follow-up: ${trimmed}`);
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

  void refreshContextUsage();
  updateFooter();
  return {
    editor,
    updateFooter,
    handleSlash,
    isResponding: () => isResponding,
  };
}

export function startThebeTui(options: ThebeTuiOptions): TUI {
  const mode: TuiMode = options.tuiMode ?? "regular";
  const terminal = new ProcessTerminal();
  const tui: TUI =
    mode === "fullscreen"
      ? new TuiAltScreen(terminal, true)
      : new TuiMainScreen(terminal);
  const chat = attachThebeChat(tui, options);
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      tui.stop();
      process.exit(0);
    }
    if (matchesKey(data, "escape")) {
      if (chat.isResponding() && options.product) {
        const id = options.sessionId ?? options.product.lastThebeSessionId();
        if (id) {
          void options.product.interrupt(id).catch(() => {});
        }
        return { consume: true };
      }
      return undefined;
    }
    return undefined;
  });
  tui.start();
  return tui;
}

/** SelectList helper for future pickers (models / sessions). */
export function attachSelectList(
  tui: TUI,
  items: SelectItem[],
  focusBack?: { focus?: () => void } | unknown,
): Promise<SelectItem | null> {
  return new Promise((resolvePromise) => {
    const list = new SelectList(
      items,
      Math.min(items.length + 2, 10),
      defaultSelectListTheme,
    );
    const origHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => {
      origHandleInput(keyData);
      tui.requestRender();
    };
    list.onSelect = (item) => {
      tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
      resolvePromise(item);
    };
    list.onCancel = () => {
      tui.removeChild(list);
      if (focusBack) tui.setFocus(focusBack as never);
      tui.requestRender();
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
