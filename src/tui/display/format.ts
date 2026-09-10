import { execSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
