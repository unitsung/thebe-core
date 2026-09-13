import type { SelectItem } from "../rendering/adapter.ts";
import type { ThebeAgent, ThinkingLevel } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import { attachSearchableModelPicker } from "../overlays/model-picker.ts";
import { THINKING_LEVELS, THINKING_DESCRIPTIONS } from "./registry.ts";
import { attachSelectList } from "../overlays/index.ts";
import { parseModelRef, resolveListedProvider } from "../overlays/model-ref.ts";
import type { SlashHost } from "./context.ts";

export async function handleAgentCommand(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
          case "model": {
            const id = await host.ensureSession();
            if (arg) {
              const trimmed = arg.trim();
              const slash = trimmed.indexOf("/");
              if (slash > 0) {
                const providerToken = trimmed.slice(0, slash);
                const modelToken = trimmed.slice(slash + 1);
                const providers = await agent.listProviders();
                const provider = resolveListedProvider(providers, providerToken);
                if (!provider) {
                  host.notice(`unknown provider: ${providerToken}`);
                  break;
                }
                const scoped = await agent.listAvailableModels({
                  providerId: provider.id,
                });
                const exact = scoped.find(
                  (m) => m.modelId.toLowerCase() === modelToken.toLowerCase(),
                );
                if (exact) {
                  await host.applyModel(id, exact);
                  break;
                }
                host.notice(`unknown model: ${provider.id}/${modelToken}`);
                break;
              }

              const available = await agent.listAvailableModels();
              const exact = available.find(
                (m) =>
                  m.modelId.toLowerCase() === trimmed.toLowerCase() ||
                  `${m.providerId}/${m.modelId}`.toLowerCase() ===
                    trimmed.toLowerCase(),
              );
              if (exact) {
                await host.applyModel(id, exact);
                break;
              }
            }

            const available = await agent.listAvailableModels();
            if (available.length === 0) {
              host.notice("no available models found");
              break;
            }
            const selected = await attachSearchableModelPicker(host.tui, {
              agent,
              currentModel: host.currentModel,
              initialQuery: arg || undefined,
              focusBack: host.editor,
            });
            if (selected) {
              await host.applyModel(id, selected);
            }
            break;
          }
          case "agents":
          case "agent": {
            const statuses = (await agent.sessionStatus()).filter(
              (session) =>
                session.streaming || session.thebeSessionId === host.sessionId,
            );
            if (statuses.length === 0) {
              host.notice("no active agent sessions");
              break;
            }
            const rows = statuses.map((s, idx) => {
              const isCurrent = s.thebeSessionId === host.sessionId;
              const currentMarker = isCurrent ? "★ " : "  ";
              const title = s.title || "untitled";
              const model = (s as { model?: { providerId: string; modelId: string } }).model;
              const modelStr = model ? `${model.providerId}/${model.modelId}` : host.currentModel || "default";
              const state = s.streaming ? chalk.cyan("streaming") : s.status === "running" ? chalk.yellow("running") : chalk.green("idle");
              return `${currentMarker}${idx + 1}. \`${s.thebeSessionId.slice(0, 8)}\` — **${title}** [${state}] (model: \`${modelStr}\`)`;
            });
            const md = `### Active Agents (${statuses.length})\n\n${rows.join("\n")}\n\n*Use \`/resume <id>\` to open a saved conversation.*`;
            host.insertBeforeFooter(host.makeMarkdown(md));
            host.tui.requestRender();
            break;
          }
          case "thinking": {
            const id = await host.ensureSession();
            if (arg) {
              if (!THINKING_LEVELS.has(arg as ThinkingLevel)) {
                host.notice("usage: /thinking off|minimal|low|medium|high|xhigh|max");
                break;
              }
              const requested = arg as ThinkingLevel;
              const applied = await host.setThinkingLevel(requested);
              host.updateFooter();
              host.updateEditorBorderColor();
              host.notice(
                applied.level === requested
                  ? `thinking level set to ${applied.level}`
                  : `thinking level ${requested} unavailable for the current model; using ${applied.level}`,
              );
              break;
            }
            const available = (await agent.getThinkingInfo(id)).availableLevels;
            const items: SelectItem[] = available.map((lvl) => {
              const isCurrent = lvl === host.currentThinking;
              const marker = isCurrent ? "✓ " : "  ";
              const desc = THINKING_DESCRIPTIONS[lvl] ?? "";
              const defaultBadge = lvl === "off" ? " · default" : "";
              return {
                label: `${marker}${lvl.padEnd(8)} ${desc}${defaultBadge}`,
                value: lvl,
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
              const requested = selected.value as ThinkingLevel;
              const applied = await host.setThinkingLevel(requested);
              host.updateFooter();
              host.updateEditorBorderColor();
              host.notice(
                applied.level === requested
                  ? `thinking level set to ${applied.level}`
                  : `thinking level ${requested} unavailable for the current model; using ${applied.level}`,
              );
            }
            break;
          }
          case "goal": {
            const trimmed = arg.trim();
            const [action] = trimmed.split(/\s+/).filter(Boolean);
            const currentId = host.sessionId ?? agent.lastThebeSessionId();
            if (!trimmed || action === "status") {
              if (!currentId) {
                host.notice("no goal; start one with /goal <objective>");
                break;
              }
              const run = agent.getGoal(currentId);
              if (!run) {
                host.notice("no goal for this conversation; start one with /goal <objective>");
                break;
              }
              host.updateGoalStatus(run);
              host.watchGoal(currentId);
              host.openTaskPane();
              host.notice(`${run.status} · checkpoint ${run.iteration}/${run.maxIterations}`);
              break;
            }
            if (action === "pause") {
              if (!currentId) {
                host.notice("no goal to pause");
                break;
              }
              const paused = await agent.pauseGoal(currentId);
              host.updateGoalStatus(paused);
              host.watchGoal(currentId);
              host.notice(`goal ${paused.status}`);
              break;
            }
            if (action === "resume") {
              if (!currentId) {
                host.notice("no goal to resume");
                break;
              }
              const resumed = await agent.resumeGoal(currentId);
              host.updateGoalStatus(resumed);
              host.watchGoal(currentId);
              host.notice(`goal ${resumed.status} · fresh isolated worker checkpoint`);
              break;
            }
            if (action === "stop" || action === "cancel") {
              if (!currentId) {
                host.notice("no goal to stop");
                break;
              }
              const stopped = await agent.stopGoal(currentId);
              host.updateGoalStatus(stopped);
              host.watchGoal(currentId);
              host.notice(`goal ${stopped.status}; stopping active worker`);
              break;
            }
            if (action === "clear") {
              if (!currentId) {
                host.notice("no goal to clear");
                break;
              }
              agent.clearGoal(currentId);
              host.clearGoalStatus();
              host.notice("goal cleared");
              break;
            }
            const id = await host.ensureSession();
            const started = await agent.startGoal({
              thebeSessionId: id,
              goal: trimmed,
            });
            host.updateGoalStatus(started);
            host.watchGoal(id);
            host.notice(`goal started · worker + independent reviewer · up to ${started.maxIterations} checkpoints · Ctrl+G to inspect`);
            void agent.waitGoal(id).then((completed) => {
              host.updateGoalStatus(completed);
              host.showGoalConclusion(completed, id);
            }).catch((error) => {
              host.notice(`goal failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            break;
          }
    default:
      return false;
  }
  return true;
}
