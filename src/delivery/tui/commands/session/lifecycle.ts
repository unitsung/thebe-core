import type { SelectItem } from "../../rendering/adapter.ts";
import type { ThebeAgent } from "../../../../agent/index.ts";
import { attachSearchableSessionPicker } from "../../overlays/session-picker.ts";
import { attachSelectList } from "../../overlays/index.ts";
import { parseModelRef } from "../../overlays/model-ref.ts";
import type { SlashHost } from "../context.ts";

export async function handleSessionLifecycle(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
case "new": {
  const parsed = parseModelRef(host.currentModel);
  const meta = await agent.createSession({
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
    const all = await agent.listSessions();
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
      agent,
      currentSessionId: host.sessionId,
      initialQuery: arg || undefined,
      focusBack: host.editor,
    });
    if (selected) {
      targetSessionId = selected.thebeSessionId;
    }
  }

  if (targetSessionId) {
    const meta = await agent.resume(targetSessionId);
    host.sessionId = meta.thebeSessionId;
    host.sessionTitle = meta.title;
    await host.loadAndDisplaySessionHistory(host.sessionId);
    void host.refreshContextUsage();
    host.updateFooter();
    host.notice(`resumed session ${host.sessionId} (${meta.title ?? "untitled"})`);
  }
  break;
}
case "delete": {
  const rows = await agent.listSessions();
  const lowerArg = arg.toLowerCase();
  const target = arg
    ? rows.find(
        (row) =>
          row.thebeSessionId.toLowerCase() === lowerArg ||
          row.thebeSessionId.toLowerCase().startsWith(lowerArg) ||
          row.title?.toLowerCase() === lowerArg,
      )
    : rows.find((row) => row.thebeSessionId === host.sessionId);
  if (!target) {
    host.notice(arg ? `session not found: ${arg}` : "no active session to delete");
    break;
  }
  const confirmed = await attachSelectList(
    host.tui,
    [
      { label: "Cancel", value: "cancel" },
      {
        label: `Delete ${target.title || target.thebeSessionId.slice(0, 8)} and transcript`,
        value: "delete",
      },
    ],
    host.editor,
    undefined,
    host.getActiveSelectListTheme(),
  );
  if (confirmed?.value !== "delete") {
    host.notice("session deletion cancelled");
    break;
  }
  await agent.deleteSession(target.thebeSessionId);
  if (host.sessionId === target.thebeSessionId) {
    host.sessionId = undefined;
    host.sessionTitle = undefined;
    host.clearMessagesView();
    host.updateFooter();
  }
  host.notice(`deleted session ${target.thebeSessionId.slice(0, 8)}`);
  break;
}
case "name": {
  const id = await host.ensureSession();
  if (!arg) {
    host.notice("usage: /name <title>");
    break;
  }
  await agent.patchSession(id, { title: arg });
  host.sessionTitle = arg;
  host.updateFooter();
  host.notice(`session title updated: "${arg}"`);
  break;
}
case "fork": {
  const id = await host.ensureSession();
  const turns = await agent.getForkMessages(id);
  const applyFork = async (entryId?: string, selectedText?: string) => {
    const meta = await agent.fork(
      id,
      entryId ? { atEntryId: entryId } : undefined,
    );
    host.sessionId = meta.thebeSessionId;
    host.sessionTitle = meta.title;
    await host.loadAndDisplaySessionHistory(host.sessionId);
    // Pi's fork flow branches before the selected user message and puts that
    // message back in the editor so the user can continue or edit it. Keep
    // the same behavior instead of silently leaving the new branch empty.
    if (selectedText !== undefined) {
      host.editor.setText(selectedText);
    }
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
    await applyFork(target.entryId, target.text);
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
    const target = turns.find((turn) => turn.entryId === selected.value);
    await applyFork(selected.value, target?.text);
  }
  break;
}
case "tree": {
  const rows = await agent.listSessions();
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
    const meta = await agent.resume(match.thebeSessionId);
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
    const meta = await agent.resume(selected.value);
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
