import type { SubagentRun, ThebeAgent } from "../../../agent/index.ts";
import { attachPromptInput, attachSelectList } from "../overlays/index.ts";
import type { SlashHost } from "./context.ts";

async function showRuns(host: SlashHost, agent: ThebeAgent, parentSessionId: string | undefined): Promise<void> {
  const runs = await agent.listSubagents(parentSessionId);
  if (runs.length === 0) {
    host.notice("no subagent runs");
    return;
  }
  host.openTaskPane();
}

function watchRun(host: SlashHost, agent: ThebeAgent, run: SubagentRun): void {
  const unsubscribe = agent.subscribeSubagent(run.runId, (update) => {
    if (update.event?.type === "permission_requested") host.forwardRuntimeEvent(update.event);
  });
  void agent.waitSubagent(run.runId).then((completed) => {
    if (completed.status === "completed") {
      host.notice(`subagent ${completed.profileName} completed`);
      if (completed.result) {
        host.insertBeforeFooter(host.makeMarkdown(`### Subagent result · ${completed.profileName}\n\n${completed.result}`));
        host.tui.requestRender();
      }
    } else if (completed.status === "cancelled") {
      host.notice(`subagent ${completed.profileName} cancelled`);
    } else {
      host.notice(`subagent ${completed.profileName} failed: ${completed.error ?? "unknown error"}`);
    }
  }).catch((error) => {
    host.notice(`subagent failed: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(unsubscribe);
}

export async function handleSubagentCommand(host: SlashHost, agent: ThebeAgent, arg: string): Promise<boolean> {
  const [action, profileName, ...rest] = arg.split(/\s+/).filter(Boolean);
  const task = rest.join(" ");
  const parentId = host.sessionId ?? agent.lastThebeSessionId();
  if (action === "list" || arg === "list" || action === "view" || action === "inspect" || action === "open") {
    await showRuns(host, agent, parentId);
    return true;
  }
  if (action === "profiles") {
    const profiles = await agent.listSubagentProfiles();
    host.notice(profiles.length === 0 ? "no subagent profiles found" : profiles.map((profile) => `${profile.name} (${profile.scope}) — ${profile.description}`).join("\n"));
    return true;
  }
  if (action === "spawn") {
    if (!profileName || !task) {
      host.notice("usage: /subagent spawn <profile> <task>");
      return true;
    }
    const run = await agent.spawnSubagent({ profileName, taskPrompt: task, parentSessionId: await host.ensureSession() });
    host.notice(`subagent ${run.runId.slice(0, 8)} ${run.status}`);
    watchRun(host, agent, run);
    host.openTaskPane();
    return true;
  }
  if (action === "cancel") {
    if (!profileName) {
      host.notice("usage: /subagent cancel <runId>");
      return true;
    }
    const cancelled = await agent.cancelSubagent(profileName, parentId);
    host.notice(`subagent ${cancelled.runId.slice(0, 8)} ${cancelled.status}`);
    return true;
  }
  const picked = await attachSelectList(
    host.tui,
    [
      { label: "View subagent runs", value: "view" },
      { label: "Spawn subagent from profile", value: "spawn" },
      { label: "Cancel a subagent run", value: "cancel" },
      { label: "View profiles", value: "profiles" },
    ],
    host.editor,
    undefined,
    host.getActiveSelectListTheme(),
  );
  if (!picked) return true;
  if (picked.value === "view") {
    await showRuns(host, agent, parentId);
    return true;
  }
  if (picked.value === "cancel") {
    const runId = await attachPromptInput(host.tui, { prompt: "Run ID: ", placeholder: "paste the run ID or its first 8 characters", focusBack: host.editor });
    if (!runId?.trim()) return true;
    const cancelled = await agent.cancelSubagent(runId.trim(), parentId);
    host.notice(`subagent ${cancelled.runId.slice(0, 8)} ${cancelled.status}`);
    return true;
  }
  if (picked.value === "profiles") {
    const profiles = await agent.listSubagentProfiles();
    host.notice(profiles.length === 0 ? "no subagent profiles found" : profiles.map((profile) => `${profile.name} (${profile.scope}) — ${profile.description}`).join("\n"));
    return true;
  }
  const profiles = await agent.listSubagentProfiles();
  if (profiles.length === 0) {
    host.notice("no subagent profiles found");
    return true;
  }
  const profilePick = await attachSelectList(host.tui, profiles.map((profile) => ({ label: `${profile.name} — ${profile.description}`, value: profile.name })), host.editor, undefined, host.getActiveSelectListTheme());
  if (!profilePick) return true;
  const taskText = await attachPromptInput(host.tui, { prompt: "Task: ", placeholder: "required task for the subagent", focusBack: host.editor });
  if (taskText === null) return true;
  if (!taskText.trim()) {
    host.notice("subagent task cannot be empty");
    return true;
  }
  const run = await agent.spawnSubagent({ profileName: profilePick.value, taskPrompt: taskText.trim(), parentSessionId: await host.ensureSession() });
  host.notice(`subagent ${run.runId.slice(0, 8)} ${run.status}`);
  watchRun(host, agent, run);
  return true;
}
