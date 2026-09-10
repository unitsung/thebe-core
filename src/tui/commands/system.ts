import type { SelectItem, TuiMode } from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../../product/service.ts";
import type { ThinkingLevel } from "../../runtime/types.ts";
import type { ThemeName } from "../theme.ts";
import { loadThebeConfig, saveThebeConfig } from "../config.ts";
import { attachSelectList, attachSettingsMenu } from "../overlays/index.ts";
import type { SlashHost } from "./context.ts";

export async function handleSystemCommand(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
          case "tui": {
            const applyMode = async (chosen: TuiMode): Promise<void> => {
              await saveThebeConfig({ tuiMode: chosen });
              if (host.tui.mode === chosen) {
                host.notice(`TUI mode already "${chosen}"`);
                return;
              }
              if (host.options.onTuiModeChange) {
                host.notice(`switching TUI mode to "${chosen}"`);
                await host.options.onTuiModeChange(chosen);
                return;
              }
              host.notice(
                `TUI mode set to "${chosen}" (saved; host did not apply a live switch)`,
              );
            };
            if (arg) {
              if (arg === "fullscreen" || arg === "regular") {
                await applyMode(arg);
              } else {
                host.notice("usage: /tui regular|fullscreen");
              }
              break;
            }
            const currentTuiMode = host.tui.mode;
            const items: SelectItem[] = [
              {
                label: `${currentTuiMode === "regular" ? "★ " : "  "}Inline Text (regular scrolling terminal text)`,
                value: "regular",
              },
              {
                label: `${currentTuiMode === "fullscreen" ? "★ " : "  "}Fullscreen (alternate screen viewport with mouse scrolling)`,
                value: "fullscreen",
              },
            ];
            const selected = await attachSelectList(
              host.tui,
              items,
              host.editor,
              undefined,
              host.getActiveSelectListTheme(),
            );
            if (selected) {
              await applyMode(selected.value as TuiMode);
            }
            break;
          }
          case "settings": {
            const cfg = await loadThebeConfig();
            await attachSettingsMenu(host.tui, host.editor, {
              theme: host.currentTheme,
              thinking: host.currentThinking,
              tuiMode: host.tui.mode,
              autoCompact: cfg.autoCompact ?? true,
              steeringMode: cfg.steeringMode ?? "one-at-a-time",
              followUpMode: cfg.followUpMode ?? "one-at-a-time",
              hideThinking: cfg.hideThinking ?? false,
              quietStartup: cfg.quietStartup ?? false,
              fullscreenExitOutput: cfg.fullscreenExitOutput ?? "transcript",
              fullscreenScrollbar: cfg.fullscreenScrollbar ?? "auto",
              onSettingChange: async (id, value) => {
                if (id === "theme") {
                  await host.applyTheme(value as ThemeName);
                } else if (id === "thinking") {
                  if (product) {
                    const sId = host.ensureSession();
                    await product.setThinkingLevel(sId, value as ThinkingLevel);
                    host.currentThinking = value as ThinkingLevel;
                    host.updateFooter();
                    host.updateEditorBorderColor();
                  }
                  await saveThebeConfig({ defaultThinkingLevel: value });
                } else if (id === "tui") {
                  await saveThebeConfig({ tuiMode: value as TuiMode });
                  if (host.tui.mode !== value && host.options.onTuiModeChange) {
                    await host.options.onTuiModeChange(value as TuiMode);
                  }
                } else if (id === "autoCompact") {
                  const enabled = value === "true";
                  await saveThebeConfig({ autoCompact: enabled });
                  if (product && host.sessionId) {
                    try {
                      await product.setAutoCompactionEnabled(host.sessionId, enabled);
                    } catch {}
                  }
                  host.notice(
                    enabled
                      ? "auto-compact enabled (official Pi threshold/overflow)"
                      : "auto-compact disabled",
                  );
                } else if (id === "steeringMode") {
                  await saveThebeConfig({ steeringMode: value as "one-at-a-time" | "all" });
                } else if (id === "followUpMode") {
                  await saveThebeConfig({ followUpMode: value as "one-at-a-time" | "all" });
                } else if (id === "hideThinking") {
                  await saveThebeConfig({ hideThinking: value === "true" });
                } else if (id === "quietStartup") {
                  await saveThebeConfig({ quietStartup: value === "true" });
                } else if (id === "fullscreenExitOutput") {
                  await saveThebeConfig({ fullscreenExitOutput: value as "transcript" | "resume-hint" });
                } else if (id === "fullscreenScrollbar") {
                  await saveThebeConfig({ fullscreenScrollbar: value as "auto" | "always" | "hidden" });
                }
              },
            });
            break;
          }
          case "theme": {
            if (arg) {
              if (arg === "dark" || arg === "light") {
                await host.applyTheme(arg);
                host.notice(`theme set to ${arg}`);
              } else {
                host.notice("usage: /theme dark|light");
              }
              break;
            }
            const previous = host.currentTheme;
            const items: SelectItem[] = [
              { label: `${host.currentTheme === "dark" ? "★ " : "  "}Dark theme`, value: "dark" },
              { label: `${host.currentTheme === "light" ? "★ " : "  "}Light theme`, value: "light" },
            ];
            const selected = await attachSelectList(
              host.tui,
              items,
              host.editor,
              (item) => {
                void host.applyTheme(item.value as ThemeName, false);
              },
              host.getActiveSelectListTheme(),
            );
            if (selected) {
              const chosen = selected.value as ThemeName;
              await host.applyTheme(chosen);
              host.notice(`theme set to ${chosen}`);
            } else {
              await host.applyTheme(previous, false);
            }
            break;
          }
    default:
      return false;
  }
  return true;
}
