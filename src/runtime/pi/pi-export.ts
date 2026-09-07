import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeExport } from "../types.ts";
import { piDistUrl } from "./load-pi.ts";

type AgentSession = {
  sessionManager: unknown;
  state?: unknown;
};

export async function exportPiSession(
  session: AgentSession,
): Promise<RuntimeExport> {
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
}
