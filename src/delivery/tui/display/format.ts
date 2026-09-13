import { execSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "../rendering/adapter.ts";
import { chalk } from "../theme.ts";

export interface StartScreenOptions {
  version: string;
  model?: string;
  cwd: string;
  branch?: string;
  quiet?: boolean;
  width?: number;
  sessionTitle?: string;
}

export function renderStartScreen(options: StartScreenOptions): string {
  const versionStr = `v${options.version}`;
  const modelStr = options.model ? ` (connected to ${options.model})` : "";
  const header = `${chalk.bold(chalk.cyan("Thebe"))} ${chalk.dim(`${versionStr}${modelStr}`)}`;

  if (options.quiet) {
    return `${header}\n${chalk.dim("Enter send · Alt+Enter queue · / commands · Ctrl+P model · Ctrl+G tasks · Ctrl+Shift+G child")}\n`;
  }

  const termWidth = options.width ?? (process.stdout?.columns ? process.stdout.columns : 80);
  const cardWidth = Math.min(Math.max(42, termWidth - 2), 72);

  const home = process.env.HOME || process.env.USERPROFILE;
  const cwdDisplay = formatCwdForFooter(options.cwd, home);
  const branchDisplay = options.branch ? `(git: ${chalk.cyan(options.branch)})` : "";

  function makeCardLine(content: string, targetWidth: number): string {
    const vis = visibleWidth(content);
    if (vis > targetWidth - 4) {
      const truncated = truncateToWidth(content, targetWidth - 4, "…");
      const visTrunc = visibleWidth(truncated);
      const pad = Math.max(0, targetWidth - 4 - visTrunc);
      return `${chalk.dim("│ ")}${truncated}${" ".repeat(pad)}${chalk.dim(" │")}`;
    }
    const pad = Math.max(0, targetWidth - 4 - vis);
    return `${chalk.dim("│ ")}${content}${" ".repeat(pad)}${chalk.dim(" │")}`;
  }

  const topBorder = chalk.dim(`╭${"─".repeat(cardWidth - 2)}╮`);
  const botBorder = chalk.dim(`╰${"─".repeat(cardWidth - 2)}╯`);

  const cardTitle = `${chalk.bold.cyan("✦ Thebe Agent")} ${chalk.dim(`v${options.version}`)} · ${chalk.green("Ready")}`;
  const workspaceLine = `${cwdDisplay} ${branchDisplay}`.trim();
  const modelLine = options.model
    ? `${options.model} · Shift+Tab thinking level`
    : "no model · Shift+Tab thinking level";

  const lines = [
    topBorder,
    makeCardLine(cardTitle, cardWidth),
    makeCardLine(workspaceLine, cardWidth),
    makeCardLine(modelLine, cardWidth),
    botBorder,
    "",
  ];

  if (options.sessionTitle) {
    lines.push(chalk.dim(`session: ${options.sessionTitle}`));
  }

  lines.push(
    chalk.dim("Ask anything · / commands · ! bash · Ctrl+P model"),
    chalk.dim("Ctrl+T thinking · Ctrl+O tools · Alt+Enter queue · Esc cancel"),
    chalk.dim("Ctrl+G tasks · Ctrl+Shift+G open active child"),
    "",
  );

  return lines.join("\n");
}

/**
 * Compact token display. Same rules as official Pi
 * `FooterComponent.formatTokens` (not on the package public export).
 */
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

export function getGitBranch(cwd = process.cwd()): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd,
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

export function formatSessionAge(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
