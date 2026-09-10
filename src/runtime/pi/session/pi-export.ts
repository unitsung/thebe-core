import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeExport } from "../../types.ts";
import { piDistUrl } from "../sdk/load-pi.ts";

type AgentSession = {
  sessionManager: unknown;
  state?: unknown;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fallbackExport(session: AgentSession): RuntimeExport {
  const raw = (session as { messages?: unknown }).messages;
  const messages = Array.isArray(raw)
    ? raw
    : typeof raw === "function"
      ? ((raw as () => unknown[])() ?? [])
      : [];
  const rows = messages.map((message) => {
    const row = (message ?? {}) as {
      role?: string;
      text?: string;
      content?: unknown;
    };
    const text =
      typeof row.text === "string"
        ? row.text
        : typeof row.content === "string"
          ? row.content
          : JSON.stringify(row.content ?? row);
    return {
      role: row.role ?? "unknown",
      text,
    };
  });
  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n");
  const htmlRows = rows
    .map(
      (row) =>
        `<li><strong>${escapeHtml(row.role)}</strong><pre>${escapeHtml(row.text)}</pre></li>`,
    )
    .join("\n");
  return {
    jsonl,
    html: `<!DOCTYPE html><html><body><ol>${htmlRows}</ol></body></html>`,
  };
}

export async function exportPiSession(
  session: AgentSession,
): Promise<RuntimeExport> {
  try {
    const jsonlMod = (await import(piDistUrl("core/session-export.js"))) as {
      exportSessionToJsonl: (
        manager: AgentSession["sessionManager"],
        outputPath?: string,
      ) => string;
    };
    const htmlMod = (await import(piDistUrl("core/export-html/index.js"))) as {
      exportSessionToHtml: (
        manager: AgentSession["sessionManager"],
        state?: unknown,
        options?: string | { outputPath?: string },
      ) => Promise<string>;
    };
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-export-"));
    try {
      const jsonlPath = jsonlMod.exportSessionToJsonl(
        session.sessionManager,
        join(dir, "session.jsonl"),
      );
      const jsonl = await readFile(jsonlPath, "utf8");
      const htmlPath = await htmlMod.exportSessionToHtml(
        session.sessionManager,
        session.state,
        { outputPath: join(dir, "session.html") },
      );
      const html =
        htmlPath.includes("<") && !existsSync(htmlPath)
          ? htmlPath
          : await readFile(htmlPath, "utf8");
      return { jsonl, html };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch {
    return fallbackExport(session);
  }
}
