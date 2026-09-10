import type { SelectItem } from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../../../product/service.ts";
import { attachSearchableSessionPicker } from "../../overlays/session-picker.ts";
import { attachSelectList } from "../../overlays/index.ts";
import { parseModelRef } from "../../overlays/model-ref.ts";
import type { SlashHost } from "../context.ts";

export async function handleSessionLifecycle(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
case "new": {
  const parsed = parseModelRef(host.currentModel);
  const meta = await product.createSession({
    title: arg || host.options.title,
    model: parsed.providerId
      ? { providerId: parsed.providerId, modelId: parsed.modelId }
      : undefined,
  });
  host.sessionId = meta.thebeSessionId;
  host.sessionTitle = meta.title;
  host.clearMessagesView();
  void host.refreshContextUsage();
  host.updateFooter();
  host.notice(`new session created: ${host.sessionId}`);
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
      host.notice(`session not found: ${arg}`);
      break;
    }
    targetSessionId = match.thebeSessionId;
  } else {
    const selected = await attachSearchableSessionPicker(host.tui, {
      product,
      currentSessionId: host.sessionId,
      initialQuery: arg || undefined,
      focusBack: host.editor,
    });
    if (selected) {
      targetSessionId = selected.thebeSessionId;
    }
  }

  if (targetSessionId) {
    const meta = await product.resume(targetSessionId);
    host.sessionId = meta.thebeSessionId;
    host.sessionTitle = meta.title;
    await host.loadAndDisplaySessionHistory(host.sessionId);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice(`resumed session ${host.sessionId} (${meta.title ?? "untitled"})`);
  }
  break;
}
case "name": {
  const id = host.ensureSession();
  if (!arg) {
    host.notice("usage: /name <title>");
    break;
  }
  await product.patchSession(id, { title: arg });
  host.sessionTitle = arg;
  host.updateFooter();
  host.notice(`session title updated: "${arg}"`);
  break;
}
case "fork": {
  const id = host.ensureSession();
  const turns = await product.getForkMessages(id);
  const applyFork = async (entryId?: string) => {
    const meta = await product.fork(
      id,
      entryId ? { atEntryId: entryId } : undefined,
    );
    host.sessionId = meta.thebeSessionId;
    host.sessionTitle = meta.title;
    await host.loadAndDisplaySessionHistory(host.sessionId);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice(
      entryId
        ? `forked session ${host.sessionId} from ${entryId.slice(0, 8)}`
        : `forked session ${host.sessionId}`,
    );
  };
  if (arg) {
    const byIndex = /^\d+$/.test(arg)
      ? turns[Number(arg) - 1]
      : undefined;
    const lower = arg.toLowerCase();
    const byId = turns.find(
      (turn) =>
        turn.entryId === arg ||
        turn.entryId.toLowerCase().startsWith(lower),
    );
    const target = byId ?? byIndex;
    if (!target) {
      host.notice(`fork turn not found: ${arg}`);
      break;
    }
    await applyFork(target.entryId);
    break;
  }
  if (turns.length === 0) {
    host.notice("no user turns to fork from");
    break;
  }
  const items: SelectItem[] = turns.map((turn, index) => {
    const preview = turn.text.replace(/\s+/g, " ").slice(0, 72);
    return {
      label: `${index + 1}. ${preview}${turn.text.length > 72 ? "..." : ""}`,
      value: turn.entryId,
    };
  });
  const selected = await attachSelectList(
    host.tui,
    items,
    host.editor,
    undefined,
    host.getActiveSelectListTheme(),
  );
  if (selected) {
    await applyFork(selected.value);
  }
  break;
}
case "tree": {
  const rows = await product.listSessions();
  if (arg) {
    const lower = arg.toLowerCase();
    const match = rows.find(
      (row) =>
        row.thebeSessionId.toLowerCase() === lower ||
        row.thebeSessionId.toLowerCase().startsWith(lower),
    );
    if (!match) {
      host.notice(`session branch not found: ${arg}`);
      break;
    }
    const meta = await product.resume(match.thebeSessionId);
    host.sessionId = meta.thebeSessionId;
    host.sessionTitle = meta.title;
    await host.loadAndDisplaySessionHistory(host.sessionId);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice(`switched to branch ${host.sessionId.slice(0, 8)}`);
    break;
  }
  if (rows.length === 0) {
    host.notice("(no sessions found)");
    break;
  }
  const items: SelectItem[] = rows.map((row) => {
    const marker = row.thebeSessionId === host.sessionId ? "★ " : "● ";
    const parent = row.parentThebeSessionId ? "  " : "";
    return {
      label: `${parent}${marker}${row.thebeSessionId.slice(0, 8)} (${row.title || "untitled"}) [${row.status ?? "idle"}]`,
      value: row.thebeSessionId,
    };
  });
  const selected = await attachSelectList(
    host.tui,
    items,
    host.editor,
    undefined,
    host.getActiveSelectListTheme(),
  );
  if (selected) {
    const meta = await product.resume(selected.value);
    host.sessionId = meta.thebeSessionId;
    host.sessionTitle = meta.title;
    await host.loadAndDisplaySessionHistory(host.sessionId);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice(`switched to branch ${host.sessionId.slice(0, 8)}`);
  }
  break;
}
    default:
      return false;
  }
  return true;
}
