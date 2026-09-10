import type { SelectItem } from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../../product/service.ts";
import type { ThinkingLevel } from "../../runtime/types.ts";
import { chalk } from "../theme.ts";
import { attachSearchableModelPicker } from "../overlays/model-picker.ts";
import { THINKING_LEVELS, THINKING_DESCRIPTIONS } from "../slash.ts";
import { attachSelectList } from "../overlays/index.ts";
import { parseModelRef, resolveListedProvider } from "../overlays/model-ref.ts";
import type { SlashHost } from "./context.ts";

export async function handleAgentCommand(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
          case "model": {
            const id = host.ensureSession();
            if (arg) {
              const trimmed = arg.trim();
              const slash = trimmed.indexOf("/");
              if (slash > 0) {
                const providerToken = trimmed.slice(0, slash);
                const modelToken = trimmed.slice(slash + 1);
                const providers = await product.listProviders();
                const provider = resolveListedProvider(providers, providerToken);
                if (!provider) {
                  host.notice(`unknown provider: ${providerToken}`);
                  break;
                }
                const scoped = await product.listAvailableModels({
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

              const available = await product.listAvailableModels();
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

            const available = await product.listAvailableModels();
            if (available.length === 0) {
              host.notice("no available models found");
              break;
            }
            const selected = await attachSearchableModelPicker(host.tui, {
              product,
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
            const statuses = await product.sessionStatus();
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
            const md = `### Active Agent Sessions (${statuses.length})\n\n${rows.join("\n")}\n\n*Use \`/resume <id>\` to switch active agent session.*`;
            host.insertBeforeFooter(host.makeMarkdown(md));
            host.tui.requestRender();
            break;
          }
          case "thinking": {
            const id = host.ensureSession();
            if (arg) {
              if (!THINKING_LEVELS.has(arg as ThinkingLevel)) {
                host.notice("usage: /thinking off|minimal|low|medium|high|xhigh|max");
                break;
              }
              await product.setThinkingLevel(id, arg as ThinkingLevel);
              host.currentThinking = arg as ThinkingLevel;
              host.updateFooter();
              host.updateEditorBorderColor();
              host.notice(`thinking level set to ${arg}`);
              break;
            }
            const items: SelectItem[] = Array.from(THINKING_LEVELS).map((lvl) => {
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
              await product.setThinkingLevel(id, selected.value as ThinkingLevel);
              host.currentThinking = selected.value as ThinkingLevel;
              host.updateFooter();
              host.updateEditorBorderColor();
              host.notice(`thinking level set to ${selected.value}`);
            }
            break;
          }
    default:
      return false;
  }
  return true;
}
