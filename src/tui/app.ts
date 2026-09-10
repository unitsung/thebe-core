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
  Input,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  SettingsList,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
  type SettingItem,
  type SettingsListTheme,
  type SlashCommand,
  type TUI,
  type TuiMode,
} from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../product/service.ts";
import type {
  NormalizedEvent,
  RuntimeProvider,
  ThinkingLevel,
} from "../runtime/types.ts";
import {
  chalk,
  defaultSelectListTheme,
  getTuiTheme,
  type ThemeName,
} from "./theme.ts";
import {
  attachSearchableModelPicker,
  attachSearchableProviderPicker,
} from "./model-picker.ts";
import { attachSearchableSessionPicker } from "./session-picker.ts";
import { saveThebeConfig, saveProviderEndpoint } from "./config.ts";

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
  theme?: ThemeName;
  /** Invoked after `/tui` persists a mode so the host can swap the live screen. */
  onTuiModeChange?: (mode: TuiMode) => void | Promise<void>;
};

export type SlashCategory = "Session" | "Agent" | "Provider" | "System";

export type ThebeSlashCommand = SlashCommand & {
  category: SlashCategory;
  aliases?: string[];
};

/** Same grouping OpenCode uses in the command palette: Session / Agent / Provider / System. */
export const SLASH_COMMANDS: ThebeSlashCommand[] = [
  // Session
  { name: "sessions", category: "Session", aliases: ["resume", "continue"], description: "Browse and switch sessions", argumentHint: "[query]" },
  { name: "new", category: "Session", description: "Start a new session", argumentHint: "[title]" },
  { name: "name", category: "Session", aliases: ["rename"], description: "Set session title", argumentHint: "<title>" },
  { name: "fork", category: "Session", description: "Fork session", argumentHint: "[messageId]" },
  { name: "compact", category: "Session", aliases: ["summarize"], description: "Compact context" },
  { name: "export", category: "Session", description: "Export session to HTML and JSONL", argumentHint: "[path]" },
  { name: "copy", category: "Session", description: "Copy last assistant message to clipboard" },
  { name: "revert", category: "Session", aliases: ["undo"], description: "Revert last user turn" },
  { name: "clear", category: "Session", description: "Clear the visible transcript" },
  // Agent
  { name: "model", category: "Agent", aliases: ["models", "mo"], description: "Switch model", argumentHint: "[provider/model]" },
  { name: "thinking", category: "Agent", description: "Set thinking level", argumentHint: "[level]" },
  // Provider
  { name: "login", category: "Provider", aliases: ["connect"], description: "Connect provider (API key, endpoint, or OAuth)", argumentHint: "[provider]" },
  { name: "logout", category: "Provider", description: "Remove provider credentials", argumentHint: "[provider]" },
  // System
  { name: "theme", category: "System", aliases: ["themes"], description: "Switch theme", argumentHint: "[dark|light]" },
  { name: "settings", category: "System", description: "Theme, thinking, TUI mode" },
  { name: "tui", category: "System", description: "regular or fullscreen viewport", argumentHint: "[regular|fullscreen]" },
  { name: "usage", category: "System", aliases: ["session", "status"], description: "Token and context usage" },
  { name: "hotkeys", category: "System", description: "Keyboard shortcuts" },
  { name: "help", category: "System", description: "Show commands by category" },
  { name: "quit", category: "System", aliases: ["exit", "q"], description: "Quit Thebe" },
];

const SLASH_ALIAS_TO_NAME = new Map<string, string>();
for (const command of SLASH_COMMANDS) {
  for (const alias of command.aliases ?? []) {
    SLASH_ALIAS_TO_NAME.set(alias, command.name);
  }
}

const EXTRA_SLASH_ALIASES = new Map<string, string>([
  ["fork", "fork"],
  ["tree", "tree"],
  ["interrupt", "interrupt"],
  ["allow", "allow"],
  ["deny", "deny"],
  ["provider", "provider"],
  ["followup", "followup"],
  ["unrevert", "unrevert"],
]);

export function resolveSlashName(name: string): string {
  return SLASH_ALIAS_TO_NAME.get(name) ?? EXTRA_SLASH_ALIASES.get(name) ?? name;
}

function slashCommandsForAutocomplete(): SlashCommand[] {
  return SLASH_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
  }));
}

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

function writeOsc52(text: string, write: (data: string) => void): boolean {
  try {
    const payload = Buffer.from(text, "utf8").toString("base64");
    write(`\x1b]52;c;${payload}\x07`);
    return true;
  } catch {
    return false;
  }
}

export function openBrowser(target: string): void {
  if (!process.stdout.isTTY) return;
  const [cmd, args] =
    process.platform === "darwin"
      ? (["open", [target]] as const)
      : process.platform === "win32"
        ? (["rundll32", ["url.dll,FileProtocolHandler", target]] as const)
        : (["xdg-open", [target]] as const);
  spawn(cmd, [...args], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/** Same fallbacks Pi uses: native tool, then OSC 52 (especially over SSH). */
export async function copyToClipboard(
  text: string,
  write?: (data: string) => void,
): Promise<boolean> {
  const options = {
    input: text,
    timeout: 5000,
    stdio: ["pipe", "ignore", "ignore"] as ["pipe", "ignore", "ignore"],
  };
  let copied = false;
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", options);
      copied = true;
    } else if (process.platform === "win32") {
      execSync("clip", options);
      copied = true;
    } else {
      try {
        execSync("xclip -selection clipboard", options);
        copied = true;
      } catch {
        execSync("xsel --clipboard --input", options);
        copied = true;
      }
    }
  } catch {
    copied = false;
  }
  const remote = Boolean(
    process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.MOSH_CONNECTION,
  );
  if (!copied || remote) {
    const oscWrite = write ?? ((data: string) => {
      process.stdout.write(data);
    });
    copied = writeOsc52(text, oscWrite) || copied;
  }
  return copied;
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
  let currentModel = options.model ?? "";
  let currentThinking: ThinkingLevel = "off";
  let currentTheme: ThemeName = options.theme ?? "dark";
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

  const editor = new Editor(tui, getTuiTheme(currentTheme).editor);
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(slashCommandsForAutocomplete(), process.cwd()),
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
    const parsedModel = parseModelRef(currentModel);
    const providerId = parsedModel.providerId;
    const modelId = parsedModel.modelId || currentModel || "no model";

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
    const width = tui.terminal?.columns ?? process.stdout.columns ?? 80;
    const fitted = text
      .split("\n")
      .map((line) => truncateToWidth(line, width, ""))
      .join("\n");
    const index = children.indexOf(footerText);
    const insertAt = index >= 0 ? index : children.length - 1;
    children.splice(insertAt, 0, new Text(chalk.dim(fitted)));
    tui.requestRender();
  }

  async function applyModel(
    id: string,
    selected: { providerId: string; modelId: string; displayName?: string },
  ): Promise<void> {
    const newKey = `${selected.providerId}/${selected.modelId}`;
    await product!.setModel(id, {
      providerId: selected.providerId,
      modelId: selected.modelId,
    });
    currentModel = newKey;
    void refreshContextUsage();
    updateFooter();
    notice(
      `switched model to ${currentModel} (${selected.displayName ?? selected.modelId})`,
    );
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
    return getTuiTheme(currentTheme).markdown;
  }

  function makeMarkdown(text: string): Markdown {
    const md = new Markdown(text, 1, 1, getActiveMarkdownTheme());
    stashMarkdownSource(md, text);
    return md;
  }

  async function applyTheme(name: ThemeName, persist = true): Promise<void> {
    currentTheme = name;
    const pack = getTuiTheme(name);
    editor.borderColor = pack.editor.borderColor;
    for (const child of children) {
      child.invalidate?.();
    }
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!(child instanceof Markdown)) continue;
      const source = readMarkdownSource(child);
      const replacement = makeMarkdown(source);
      children[i] = replacement;
      if (replyMarkdown === child) {
        replyMarkdown = replacement;
      }
    }
    if (persist) {
      await saveThebeConfig({ theme: name });
    }
    tui.requestRender();
  }

  function clearMessagesView(): void {
    const keep = new Set([children[0], footerText, editor]);
    for (let i = children.length - 1; i >= 0; i--) {
      if (!keep.has(children[i])) {
        children.splice(i, 1);
      }
    }
    tui.requestRender();
  }

  async function loadAndDisplaySessionHistory(thebeId: string): Promise<void> {
    if (!product) return;
    clearMessagesView();
    try {
      const msgs = await product.loadMessages(thebeId);
      for (const m of msgs) {
        if (m.role === "user" && m.text) {
          insertBeforeFooter(makeMarkdown(m.text));
        } else if (m.role === "assistant" && m.text) {
          insertBeforeFooter(makeMarkdown(m.text));
        }
      }
      tui.requestRender();
    } catch {}
  }

  async function afterProviderLoggedIn(
    providerId: string,
    actionLabel: string,
  ): Promise<void> {
    if (!product || !sessionId) {
      notice(actionLabel);
      return;
    }
    const scoped = await product.listAvailableModels({ providerId });
    if (scoped.length === 0) {
      notice(
        `${actionLabel}. no models available for ${providerId}; use /model after models appear`,
      );
      return;
    }
    await applyModel(sessionId, scoped[0]!);
    notice(
      `${actionLabel}. selected ${scoped[0]!.providerId}/${scoped[0]!.modelId}`,
    );
  }

  async function resolvePermissionInteractively(
    permissionId: string,
    toolName: string,
  ): Promise<void> {
    if (!product) return;
    const selected = await attachSelectList(
      tui,
      [
        { label: `Allow ${toolName}`, value: "allow" },
        { label: `Deny ${toolName}`, value: "deny" },
      ],
      editor,
    );
    const id = sessionId ?? product.lastThebeSessionId();
    if (!selected || !id) {
      if (!selected) {
        notice(`permission ${permissionId} not resolved — /allow or /deny`);
      }
      return;
    }
    await product.resolvePermission(id, permissionId, {
      response: selected.value as "allow" | "deny",
    });
    if (pendingPermissionId === permissionId) {
      pendingPermissionId = undefined;
    }
    notice(
      `permission ${permissionId} ${selected.value === "allow" ? "allowed" : "denied"}`,
    );
  }

  function beginStream(label = "Thinking..."): void {
    replyMarkdown = makeMarkdown("");
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
        const replacement = makeMarkdown(next);
        children[index] = replacement;
        replyMarkdown = replacement;
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
        `permission requested: ${event.toolName} (${event.risk ?? "standard"}) ${event.argsSummary ?? ""}`,
      );
      void resolvePermissionInteractively(event.permissionId, event.toolName);
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
      insertBeforeFooter(makeMarkdown(text));
      beginStream();
      try {
        const reply = await options.send(text);
        if (replyMarkdown) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = makeMarkdown(reply);
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
      insertBeforeFooter(makeMarkdown(text));
      beginStream();
      streamUnsub = product.subscribeLog(id, onEvent);
      try {
        const result = await product.prompt(text, {
          thebeSessionId: id,
          mode: "prompt",
        });
        if (replyMarkdown && !readMarkdownSource(replyMarkdown)) {
          const index = children.indexOf(replyMarkdown);
          if (index >= 0) {
            children[index] = makeMarkdown(result.text);
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
    const rawName = (space < 0 ? body : body.slice(0, space)).toLowerCase();
    const name = resolveSlashName(rawName);
    const arg = space < 0 ? "" : body.slice(space + 1).trim();

    if (name === "help") {
      const categories: SlashCategory[] = [
        "Session",
        "Agent",
        "Provider",
        "System",
      ];
      const lines = ["Thebe Commands:"];
      for (const category of categories) {
        const group = SLASH_COMMANDS.filter((c) => c.category === category);
        if (group.length === 0) continue;
        lines.push("", category);
        for (const c of group) {
          const alias =
            c.aliases && c.aliases.length > 0
              ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})`
              : "";
          lines.push(
            `  /${c.name.padEnd(12)} ${c.argumentHint ?? ""} — ${c.description ?? ""}${alias}`,
          );
        }
      }
      notice(lines.join("\n"));
      return true;
    }
    if (name === "hotkeys") {
      notice(
        [
          "Keyboard shortcuts:",
          "  Enter        send (steer when busy)",
          "  Alt+Enter    queue follow-up",
          "  Esc          interrupt",
          "  Ctrl+P       switch model",
          "  Shift+Tab    cycle thinking",
          "  Ctrl+C       quit",
          "  /help        commands by category (Session, Agent, Provider, System)",
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
          const parsed = parseModelRef(currentModel);
          const meta = await product.createSession({
            title: arg || options.title,
            model: parsed.providerId
              ? { providerId: parsed.providerId, modelId: parsed.modelId }
              : undefined,
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
          let targetSessionId: string | undefined;
          if (arg && !arg.includes(" ")) {
            const all = await product.listSessions();
            const lowerArg = arg.toLowerCase();
            const match = all.find((s) =>
              s.thebeSessionId.toLowerCase() === lowerArg ||
              s.thebeSessionId.toLowerCase().startsWith(lowerArg) ||
              (s.title && s.title.toLowerCase().includes(lowerArg)),
            );
            if (!match) {
              notice(`session not found: ${arg}`);
              break;
            }
            targetSessionId = match.thebeSessionId;
          } else {
            const selected = await attachSearchableSessionPicker(tui, {
              product,
              currentSessionId: sessionId,
              initialQuery: arg || undefined,
              focusBack: editor,
            });
            if (selected) {
              targetSessionId = selected.thebeSessionId;
            }
          }

          if (targetSessionId) {
            const meta = await product.resume(targetSessionId);
            sessionId = meta.thebeSessionId;
            sessionTitle = meta.title;
            await loadAndDisplaySessionHistory(sessionId);
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

          // Calculate turns and counts
          let userTurns = 0;
          let assistantTurns = 0;
          let toolCalls = 0;
          let messageInputTokens = 0;
          let messageOutputTokens = 0;
          let messageCacheReadTokens = 0;
          let messageCacheWriteTokens = 0;

          for (const m of msgs) {
            if (m.role === "user") {
              userTurns += 1;
            } else if (m.role === "assistant") {
              assistantTurns += 1;
            } else if (m.role === "tool" || m.toolName) {
              toolCalls += 1;
            }
            // If runtime message contains nested usage stats
            const rawUsage = (m as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
            if (rawUsage) {
              messageInputTokens += rawUsage.input ?? 0;
              messageOutputTokens += rawUsage.output ?? 0;
              messageCacheReadTokens += rawUsage.cacheRead ?? 0;
              messageCacheWriteTokens += rawUsage.cacheWrite ?? 0;
            }
          }

          const totalTurns = userTurns + assistantTurns;
          const effectiveInputTokens = Math.max(cumulativeInputTokens, messageInputTokens);
          const effectiveOutputTokens = Math.max(cumulativeOutputTokens, messageOutputTokens);
          const effectiveCacheRead = messageCacheReadTokens;
          const effectiveCacheWrite = messageCacheWriteTokens;
          const totalTokens = effectiveInputTokens + effectiveOutputTokens + effectiveCacheRead + effectiveCacheWrite;

          // Cache hit rate: cacheRead / (input + cacheRead)
          const totalInputWithCache = effectiveInputTokens + effectiveCacheRead;
          const cacheHitRate = totalInputWithCache > 0 ? (effectiveCacheRead / totalInputWithCache) * 100 : 0;

          const pct = u.maxTokens > 0 ? (u.usedTokens / u.maxTokens) * 100 : 0;
          const barWidth = 24;
          const filled = Math.min(barWidth, Math.max(0, Math.round((pct / 100) * barWidth)));
          const empty = barWidth - filled;
          const meter = `[${chalk.cyan("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct.toFixed(1)}%`;

          const lines = [
            chalk.cyan("─── Token & Usage Details ──────────────────────────────────────"),
            `Session:       ${meta.thebeSessionId} (${meta.title ?? "untitled"})`,
            `Model:         ${currentModel} · Thinking: ${currentThinking}`,
            `Context Bar:   ${meter}`,
            `Context Window:${formatTokens(u.usedTokens)} / ${formatTokens(u.maxTokens)} tokens (${u.usedTokens.toLocaleString()} / ${u.maxTokens.toLocaleString()})`,
            "",
            chalk.bold("Activity & Turns:"),
            `  • Total Turns:       ${totalTurns} (User: ${userTurns} · Assistant: ${assistantTurns})`,
            `  • Tool Executions:   ${toolCalls}`,
            `  • Total Messages:    ${msgs.length} in transcript`,
            "",
            chalk.bold("Tokens & Cache:"),
            `  • Total Tokens:      ${formatTokens(totalTokens)} (${totalTokens.toLocaleString()})`,
            `  • Input Tokens:      ${formatTokens(effectiveInputTokens)} (${effectiveInputTokens.toLocaleString()})`,
            `  • Output Tokens:     ${formatTokens(effectiveOutputTokens)} (${effectiveOutputTokens.toLocaleString()})`,
            `  • Cached Tokens:     Read: ${formatTokens(effectiveCacheRead)} (${effectiveCacheRead.toLocaleString()}) · Write: ${formatTokens(effectiveCacheWrite)} (${effectiveCacheWrite.toLocaleString()})`,
            `  • Cache Hit Rate:    ${chalk.cyan(cacheHitRate.toFixed(1) + "%")} (${effectiveCacheRead.toLocaleString()} of ${totalInputWithCache.toLocaleString()} prompt tokens)`,
            "",
            chalk.bold("Status:"),
            `  • Auto-Compaction:   Near Threshold: ${compaction.nearThreshold ? chalk.yellow("YES (approaching limit)") : chalk.green("No")}${compaction.lastCompactedAt ? ` · Last: ${compaction.lastCompactedAt.slice(0, 19).replace("T", " ")}` : ""}`,
            estimatedCost ? `  • Estimated Cost:    $${estimatedCost.amount.toFixed(4)} ${estimatedCost.currency}` : undefined,
            chalk.cyan("────────────────────────────────────────────────────────────────"),
          ].filter(Boolean) as string[];
          notice(lines.join("\n"));
          break;
        }
        case "tui": {
          const applyMode = async (chosen: TuiMode): Promise<void> => {
            await saveThebeConfig({ tuiMode: chosen });
            if (tui.mode === chosen) {
              notice(`TUI mode already "${chosen}"`);
              return;
            }
            if (options.onTuiModeChange) {
              notice(`switching TUI mode to "${chosen}"`);
              await options.onTuiModeChange(chosen);
              return;
            }
            notice(
              `TUI mode set to "${chosen}" (saved; host did not apply a live switch)`,
            );
          };
          if (arg) {
            if (arg === "fullscreen" || arg === "regular") {
              await applyMode(arg);
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
            await applyMode(selected.value as TuiMode);
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
          if (arg) {
            const trimmed = arg.trim();
            const slash = trimmed.indexOf("/");
            if (slash > 0) {
              const providerToken = trimmed.slice(0, slash);
              const modelToken = trimmed.slice(slash + 1);
              const providers = await product.listProviders();
              const provider = resolveListedProvider(providers, providerToken);
              if (!provider) {
                notice(`unknown provider: ${providerToken}`);
                break;
              }
              const scoped = await product.listAvailableModels({
                providerId: provider.id,
              });
              const exact = scoped.find(
                (m) => m.modelId.toLowerCase() === modelToken.toLowerCase(),
              );
              if (exact) {
                await applyModel(id, exact);
                break;
              }
              notice(`unknown model: ${provider.id}/${modelToken}`);
              break;
            }

            const available = await product.listAvailableModels();
            const exact = available.find(
              (m) =>
                m.modelId.toLowerCase() === trimmed.toLowerCase() ||
                `${m.providerId}/${m.modelId}`.toLowerCase() ===
                  trimmed.toLowerCase(),
            );
            if (exact) {
              await applyModel(id, exact);
              break;
            }
          }

          const available = await product.listAvailableModels();
          if (available.length === 0) {
            notice("no available models found");
            break;
          }
          const selected = await attachSearchableModelPicker(tui, {
            product,
            currentModel,
            initialQuery: arg || undefined,
            focusBack: editor,
          });
          if (selected) {
            await applyModel(id, selected);
          }
          break;
        }
        case "provider": {
          const id = ensureSession();
          const providers = await product.listProviders();
          let chosenProvider: RuntimeProvider | undefined;
          if (arg) {
            chosenProvider = resolveListedProvider(providers, arg);
            if (!chosenProvider) {
              notice(`unknown provider: ${arg.trim()}`);
              break;
            }
          } else {
            chosenProvider =
              (await attachSearchableProviderPicker(tui, {
                product,
                currentModel,
                focusBack: editor,
              })) ?? undefined;
            if (!chosenProvider) {
              break;
            }
          }

          const scoped = await product.listAvailableModels({
            providerId: chosenProvider.id,
          });
          if (scoped.length === 0) {
            notice(
              `no models available for provider ${chosenProvider.id}; login may be required`,
            );
            break;
          }

          const selectedModel = await attachSearchableModelPicker(tui, {
            product,
            currentModel,
            providerFilter: chosenProvider.id,
            focusBack: editor,
          });
          if (selectedModel) {
            if (!sameProviderId(selectedModel.providerId, chosenProvider.id)) {
              notice(
                `model ${selectedModel.providerId}/${selectedModel.modelId} is not a ${chosenProvider.id} model`,
              );
              break;
            }
            await applyModel(id, selectedModel);
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
          await attachSettingsMenu(tui, editor, {
            theme: currentTheme,
            thinking: currentThinking,
            tuiMode: tui.mode,
            onTheme: (value) => applyTheme(value as ThemeName),
            onThinking: async (value) => {
              if (!product) return;
              const id = ensureSession();
              await product.setThinkingLevel(id, value as ThinkingLevel);
              currentThinking = value as ThinkingLevel;
              updateFooter();
            },
            onTuiMode: async (value) => {
              await saveThebeConfig({ tuiMode: value as TuiMode });
              if (tui.mode !== value && options.onTuiModeChange) {
                await options.onTuiModeChange(value as TuiMode);
              }
            },
          });
          break;
        }
        case "theme": {
          if (arg) {
            if (arg === "dark" || arg === "light") {
              await applyTheme(arg);
              notice(`theme set to ${arg}`);
            } else {
              notice("usage: /theme dark|light");
            }
            break;
          }
          const previous = currentTheme;
          const items: SelectItem[] = [
            { label: `${currentTheme === "dark" ? "★ " : "  "}Dark theme`, value: "dark" },
            { label: `${currentTheme === "light" ? "★ " : "  "}Light theme`, value: "light" },
          ];
          const selected = await attachSelectList(
            tui,
            items,
            editor,
            (item) => {
              void applyTheme(item.value as ThemeName, false);
            },
          );
          if (selected) {
            const chosen = selected.value as ThemeName;
            await applyTheme(chosen);
            notice(`theme set to ${chosen}`);
          } else {
            await applyTheme(previous, false);
          }
          break;
        }
        case "copy": {
          let text = "";
          if (product) {
            const id = ensureSession();
            const msgs = await product.loadMessages(id);
            text =
              msgs.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
          } else {
            const markdowns = children.filter(
              (child) => child instanceof Markdown,
            );
            text = readMarkdownSource(markdowns.at(-1) as Markdown) ?? "";
          }
          if (!text) {
            notice("no assistant response found to copy");
            break;
          }
          const write = tui.terminal
            ? (data: string) => tui.terminal!.write(data)
            : undefined;
          const ok = await copyToClipboard(text, write);
          if (ok) {
            notice(`copied last response (${text.length} chars) to clipboard`);
          } else {
            notice(
              `clipboard command unavailable; response snippet: ${text.slice(0, 120)}...`,
            );
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
          notice(
            `permission ${permissionId} ${name === "allow" ? "allowed" : "denied"}`,
          );
          break;
        }
        case "login": {
          const providers = await product.listProviders();
          let target = arg.trim();
          if (!target) {
            const chosen = await attachSearchableProviderPicker(tui, {
              product,
              currentModel,
              focusBack: editor,
            });
            if (!chosen) break;
            target = chosen.id;
          }
          const providerObj = resolveListedProvider(providers, target);
          if (!providerObj) {
            notice(`unknown provider: ${target}`);
            break;
          }
          const targetProvider = providerObj.id;
          const display = providerObj.displayName ?? targetProvider;
          const methods = providerObj.authMethods ?? ["apiKey"];
          const supportsOAuth = methods.includes("oauth");
          const supportsApiKey = methods.includes("apiKey") || methods.length === 0;

          let method: "oauth" | "apikey" = supportsOAuth ? "oauth" : "apikey";
          if (supportsOAuth && supportsApiKey) {
            const chosen = await attachSelectList(
              tui,
              [
                { label: `1. OAuth Login with ${display}`, value: "oauth" },
                { label: `2. Set API Key for ${display}`, value: "apikey" },
              ],
              editor,
            );
            if (!chosen) break;
            method = chosen.value === "apikey" ? "apikey" : "oauth";
          }

          if (method === "oauth") {
            const ok = await runOAuthLogin(
              tui,
              product,
              targetProvider,
              editor,
              notice,
            );
            if (ok) {
              await afterProviderLoggedIn(
                targetProvider,
                `logged in provider ${targetProvider} via OAuth`,
              );
            }
            break;
          }

          const apiKey = await attachPromptInput(tui, {
            prompt: chalk.cyan(`API key for ${targetProvider}: `),
            placeholder: "paste API key and press Enter",
            focusBack: editor,
          });
          if (apiKey === null) {
            notice(`login cancelled for ${targetProvider}`);
            break;
          }
          if (!apiKey.trim()) {
            notice(`API key required for ${targetProvider}`);
            break;
          }

          let customBaseUrl: string | undefined;
          if (
            (targetProvider === "openai" || targetProvider === "anthropic") &&
            process.stdin.isTTY
          ) {
            const endpoint = await attachPromptInput(tui, {
              prompt: chalk.cyan(`Base URL endpoint for ${targetProvider} (optional, Enter to skip): `),
              placeholder: targetProvider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com",
              focusBack: editor,
            });
            if (endpoint && endpoint.trim()) {
              customBaseUrl = endpoint.trim();
              await saveProviderEndpoint(targetProvider, customBaseUrl);
            }
          }

          try {
            await product.auth().setApiKey(targetProvider, apiKey.trim());
            await afterProviderLoggedIn(
              targetProvider,
              `saved API key for ${targetProvider}${customBaseUrl ? ` (endpoint: ${customBaseUrl})` : ""}`,
            );
          } catch (e) {
            notice(
              `login error for ${targetProvider}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          break;
        }
        case "logout": {
          const providers = await product.listProviders();
          let target = arg.trim();
          if (!target) {
            const chosen = await attachSearchableProviderPicker(tui, {
              product,
              currentModel,
              focusBack: editor,
            });
            if (!chosen) break;
            target = chosen.id;
          }
          const providerObj = resolveListedProvider(providers, target);
          if (!providerObj) {
            notice(`unknown provider: ${target}`);
            break;
          }
          try {
            await product.auth().logout(providerObj.id);
            notice(`logged out provider ${providerObj.id}`);
          } catch (e) {
            notice(
              `logout error for ${providerObj.id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
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
      try {
        if (await handleSlash(trimmed)) {
          return;
        }
        await runPrompt(trimmed, "prompt");
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
        isResponding = false;
        editor.disableSubmit = false;
        endStream();
      } finally {
        tui.setFocus(editor);
        tui.requestRender();
      }
    })();
  };

  const thinkingCycle: ThinkingLevel[] = [
    "off",
    "low",
    "medium",
    "high",
  ];
  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, "ctrl+p")) {
      void handleSlash("/model");
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      const idx = thinkingCycle.indexOf(currentThinking);
      const next =
        thinkingCycle[(idx < 0 ? 0 : idx + 1) % thinkingCycle.length]!;
      void handleSlash(`/thinking ${next}`);
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
  if (sessionId && product) {
    void loadAndDisplaySessionHistory(sessionId);
  }
  return {
    editor,
    updateFooter,
    handleSlash,
    isResponding: () => isResponding,
  };
}

export function startThebeTui(options: ThebeTuiOptions): TUI {
  let mode: TuiMode = options.tuiMode ?? "regular";
  const terminal = new ProcessTerminal();
  let tui: TUI | undefined;

  const launch = (): TUI => {
    tui = mode === "fullscreen"
      ? new TuiAltScreen(terminal, true)
      : new TuiMainScreen(terminal);
    tui.setClearOnShrink(true);
    const chat = attachThebeChat(tui, {
      ...options,
      tuiMode: mode,
      onTuiModeChange: async (next) => {
        if (next === mode) return;
        mode = next;
        options.tuiMode = next;
        tui?.stop();
        const nextTui = launch();
        nextTui.start();
      },
    });
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        tui?.stop();
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
    return tui;
  };

  const started = launch();
  started.start();
  return started;
}

export function parseModelRef(ref: string): {
  providerId: string;
  modelId: string;
} {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    return {
      providerId: trimmed.slice(0, slash),
      modelId: trimmed.slice(slash + 1),
    };
  }
  return { providerId: "", modelId: trimmed };
}

async function runOAuthLogin(
  tui: TUI,
  product: ThebeProduct,
  providerId: string,
  focusBack: unknown,
  notice: (text: string) => void,
): Promise<boolean> {
  try {
    notice(`initiating OAuth login for ${providerId}...`);
    const auth = product.auth();
    const res = await auth.authorizeOAuth(providerId);
    if (res.connected) {
      return true;
    }
    if (res.url) {
      openBrowser(res.url);
    }
    if (res.deviceCode?.verificationUri) {
      openBrowser(res.deviceCode.verificationUri);
    }
    const hint = [
      res.url ? `authorize in your browser: ${res.url}` : undefined,
      res.deviceCode
        ? `device login: visit ${res.deviceCode.verificationUri} and enter ${res.deviceCode.userCode}`
        : undefined,
      res.instructions,
    ]
      .filter(Boolean)
      .join("\n");
    if (hint) {
      notice(hint);
    }

    const abortController = new AbortController();
    let autoConnected = false;

    // Background poller: automatically detect when browser completes OAuth callback
    const pollTimer = setInterval(async () => {
      try {
        const check = await auth.check(providerId);
        if (check.ok) {
          autoConnected = true;
          clearInterval(pollTimer);
          abortController.abort();
        }
      } catch {}
    }, 500);

    const callback = await attachPromptInput(tui, {
      prompt: chalk.cyan(`OAuth callback for ${providerId}: `),
      placeholder: "waiting for browser callback (or paste redirect URL/code here)",
      focusBack,
      abortSignal: abortController.signal,
    });
    clearInterval(pollTimer);

    if (autoConnected) {
      return true;
    }

    if (callback === null || !callback.trim()) {
      const already = await auth.check(providerId);
      if (already.ok) {
        return true;
      }
      notice(
        callback === null
          ? `OAuth login for ${providerId} cancelled`
          : `OAuth callback required for ${providerId}`,
      );
      return false;
    }
    try {
      await auth.submitOAuthCallback(providerId, callback.trim());
    } catch (error) {
      const already = await auth.check(providerId);
      if (!already.ok) {
        throw error;
      }
    }
    const status = await auth.check(providerId);
    if (!status.ok) {
      notice(`OAuth login for ${providerId} did not connect`);
      return false;
    }
    return true;
  } catch (e) {
    notice(
      `OAuth login error for ${providerId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

export function resolveListedProvider(
  providers: RuntimeProvider[],
  token: string,
): RuntimeProvider | undefined {
  const lower = token.trim().toLowerCase();
  if (!lower) return undefined;
  return providers.find(
    (p) =>
      p.id.toLowerCase() === lower ||
      (p.displayName ?? "").toLowerCase() === lower,
  );
}

function sameProviderId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function attachPromptInput(
  tui: TUI,
  options: {
    prompt: string;
    placeholder?: string;
    focusBack?: unknown;
    abortSignal?: AbortSignal;
  },
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
      if (options.focusBack) {
        tui.setFocus(options.focusBack as never);
      }
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
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);
    const origHandleInput = input.handleInput.bind(input);
    input.handleInput = (keyData) => {
      origHandleInput(keyData);
      tui.requestRender();
    };
    tui.addChild(input);
    tui.setFocus(input);
    tui.requestRender();
  });
}

/** SelectList helper for future pickers (models / sessions). */
const defaultSettingsListTheme: SettingsListTheme = {
  label: (text, selected) => (selected ? chalk.bold.cyan(text) : text),
  value: (text, selected) => (selected ? chalk.cyan(text) : chalk.dim(text)),
  description: (text) => chalk.dim(text),
  cursor: "→ ",
  hint: (text) => chalk.dim(text),
};

function attachSettingsMenu(
  tui: TUI,
  focusBack: unknown,
  options: {
    theme: ThemeName;
    thinking: ThinkingLevel;
    tuiMode: TuiMode;
    onTheme: (value: string) => void | Promise<void>;
    onThinking: (value: string) => void | Promise<void>;
    onTuiMode: (value: string) => void | Promise<void>;
  },
): Promise<void> {
  return new Promise((resolvePromise) => {
    const items: SettingItem[] = [
      {
        id: "theme",
        label: "Theme",
        description: "TUI color theme (applied immediately)",
        currentValue: options.theme,
        values: ["dark", "light"],
      },
      {
        id: "thinking",
        label: "Thinking",
        description: "Reasoning level for the current session",
        currentValue: options.thinking,
        values: Array.from(THINKING_LEVELS),
      },
      {
        id: "tui",
        label: "TUI mode",
        description: "regular scrolling terminal or fullscreen viewport",
        currentValue: options.tuiMode,
        values: ["regular", "fullscreen"],
      },
    ];
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 10),
      defaultSettingsListTheme,
      (id, newValue) => {
        list.updateValue(id, newValue);
        tui.requestRender();
        if (id === "theme") void options.onTheme(newValue);
        if (id === "thinking") void options.onThinking(newValue);
        if (id === "tui") void options.onTuiMode(newValue);
      },
      () => {
        tui.removeChild(list);
        if (focusBack) tui.setFocus(focusBack as never);
        tui.requestRender();
        resolvePromise();
      },
    );
    const origHandleInput = list.handleInput.bind(list);
    list.handleInput = (keyData) => {
      origHandleInput(keyData);
      tui.requestRender();
    };
    tui.addChild(list);
    tui.setFocus(list);
    tui.requestRender();
  });
}

export function attachSelectList(
  tui: TUI,
  items: SelectItem[],
  focusBack?: { focus?: () => void } | unknown,
  onSelectionChange?: (item: SelectItem) => void,
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
    if (onSelectionChange) {
      list.onSelectionChange = onSelectionChange;
    }
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
