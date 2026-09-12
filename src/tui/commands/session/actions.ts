import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { Markdown } from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../../../product/service.ts";
import { copyToClipboard } from "../../display/clipboard.ts";
import { readMarkdownSource } from "../../display/markdown-source.ts";
import type { SlashHost } from "../context.ts";

export async function handleSessionActions(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
case "compact": {
  const id = host.ensureSession();
  host.notice("compacting context...");
  try {
    await product.compact(id, arg || undefined);
    await host.loadAndDisplaySessionHistory(id);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice("context compacted successfully");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    if (
      /nothing to compact/i.test(message) ||
      /already compacted/i.test(message)
    ) {
      host.notice(message);
    } else {
      host.notice(`compact failed: ${message}`);
    }
  }
  break;
}
case "summary": {
  const id = host.ensureSession();
  const meta = await product.getSession(id);
  if (!meta.lastSummary) {
    host.notice("no task summary has been generated yet");
    break;
  }
  host.insertBeforeFooter(
    host.makeMarkdown(
      `### Task summary\n\n${meta.lastSummary}\n\n_Generated ${meta.lastSummaryAt ?? "at an unknown time"}_`,
    ),
  );
  host.tui.requestRender();
  break;
}
case "export": {
  const id = host.ensureSession();
  const exported = await product.exportSession(id);
  const target = arg || `./thebe-export-${id.slice(0, 8)}`;
  const base = resolve(target);
  const htmlOnly = arg.toLowerCase().endsWith(".html");
  const jsonlOnly = arg.toLowerCase().endsWith(".jsonl");
  const written: string[] = [];
  const displayPath = (abs: string): string => {
    const rel = relative(process.cwd(), abs);
    return rel && !rel.startsWith("..") ? rel : abs;
  };
  if (!htmlOnly) {
    const jsonlPath = jsonlOnly
      ? base
      : base.endsWith(".html")
        ? base.replace(/\.html$/, ".jsonl")
        : `${base}.jsonl`;
    await mkdir(dirname(jsonlPath), { recursive: true });
    await writeFile(jsonlPath, exported.jsonl, "utf8");
    written.push(
      `${displayPath(jsonlPath)} (${exported.jsonl.length} bytes jsonl)`,
    );
  }
  if (!jsonlOnly) {
    const htmlPath = htmlOnly
      ? base
      : base.endsWith(".jsonl")
        ? base.replace(/\.jsonl$/, ".html")
        : `${base}.html`;
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, exported.html, "utf8");
    written.push(
      `${displayPath(htmlPath)} (${exported.html.length} bytes html)`,
    );
  }
  host.notice(`exported session to\n${written.map((row) => `  ${row}`).join("\n")}`);
  break;
}
case "copy": {
  let text = "";
  if (product) {
    const id = host.ensureSession();
    const msgs = await product.loadMessages(id);
    text =
      msgs.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  }
  if (!text) {
    const markdowns = host.children.filter(
      (child) => child instanceof Markdown,
    );
    for (let i = markdowns.length - 1; i >= 0; i--) {
      const source = readMarkdownSource(markdowns[i] as Markdown);
      if (source.trim()) {
        text = source;
        break;
      }
    }
  }
  if (!text) {
    host.notice("no assistant response found to copy");
    break;
  }
  const write = host.tui.terminal
    ? (data: string) => host.tui.terminal!.write(data)
    : undefined;
  const ok = await copyToClipboard(text, write);
  if (ok) {
    host.notice(`copied last response (${text.length} chars) to clipboard`);
  } else {
    host.notice(
      `clipboard command unavailable; response snippet: ${text.slice(0, 120)}...`,
    );
  }
  break;
}
case "followup": {
  if (!arg) {
    host.notice("usage: /followup <text>");
    break;
  }
  const id = host.ensureSession();
  await product.prompt(arg, { thebeSessionId: id, mode: "followUp" });
  host.notice(`queued follow-up: ${arg}`);
  break;
}
case "interrupt": {
  const id = host.sessionId ?? product.lastThebeSessionId();
  if (id) {
    await product.interrupt(id);
    host.notice("interrupt requested");
  } else {
    host.notice("no active session to interrupt");
  }
  break;
}
case "revert": {
  const id = host.ensureSession();
  try {
    await product.revert(id);
    await host.loadAndDisplaySessionHistory(id);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice("reverted last turn (history only; external side effects remain)");
  } catch (err) {
    host.notice(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  break;
}
case "unrevert": {
  const id = host.ensureSession();
  try {
    await product.unrevert(id);
    await host.loadAndDisplaySessionHistory(id);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice("unreverted");
  } catch (err) {
    host.notice(`unrevert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  break;
}
case "history":
case "messages": {
  const id = host.ensureSession();
  const messages = await product.loadMessages(id);
  if (messages.length === 0) {
    host.notice("no messages in session");
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
      ? `Showing the last ${slice.length} of ${messages.length} messages. Use /history all or /history <n> for more.\n`
      : `Showing all ${messages.length} messages.\n`;
  host.notice(
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
  const id = host.ensureSession();
  const permissionId =
    arg ||
    host.pendingPermissionId ||
    product.pendingPermissionIds().at(-1);
  if (!permissionId) {
    host.notice("no pending permission to resolve");
    break;
  }
  await product.resolvePermission(id, permissionId, {
    response: name === "allow" ? "allow" : "deny",
  });
  if (host.pendingPermissionId === permissionId) {
    host.pendingPermissionId = undefined;
  }
  host.notice(
    `permission ${permissionId} ${name === "allow" ? "allowed" : "denied"}`,
  );
  break;
}
    default:
      return false;
  }
  return true;
}
