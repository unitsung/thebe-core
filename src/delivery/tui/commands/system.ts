import { spawn } from "node:child_process";
import { join } from "node:path";
import type { SelectItem, TuiMode } from "../rendering/adapter.ts";
import type { PermissionMode, ThebeAgent, ThinkingLevel } from "../../../agent/index.ts";
import type { ThemeName } from "../theme.ts";
import {
  ensureThebeConfigFile,
  getExternalEditorCommand,
  getThebeAgentDir,
  getThebeConfigPath,
  loadThebeConfig,
  saveThebeConfig,
} from "../settings/config.ts";
import { attachSelectList, attachSettingsMenu } from "../overlays/index.ts";
import type { SlashHost } from "./context.ts";

export async function handleSystemCommand(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
          case "permissions": {
            const applyPermissionMode = async (mode: PermissionMode): Promise<void> => {
              agent.setPermissionMode(mode);
              await saveThebeConfig({ permissionMode: mode });
              host.notice(
                mode === "full-access"
                  ? "permission mode: full-access — approval-gated tools will run without asking"
                  : mode === "read-only"
                    ? "permission mode: read-only — shell and write tools are denied"
                    : "permission mode: ask — approval-gated tools will ask before running",
              );
            };
            const normalizePermissionMode = (value: string): PermissionMode | undefined => {
              const normalized = value.trim().toLowerCase();
              if (normalized === "ask") return "ask";
              if (normalized === "read-only" || normalized === "readonly" || normalized === "deny") {
                return "read-only";
              }
              if (normalized === "full" || normalized === "full-access" || normalized === "auto") {
                return "full-access";
              }
              return undefined;
            };
            if (arg) {
              const chosen = normalizePermissionMode(arg);
              if (!chosen) {
                host.notice("usage: /permissions ask|read-only|full-access (aliases: auto, full, readonly)");
              } else {
                await applyPermissionMode(chosen);
              }
              break;
            }
            const current = agent.permissionMode();
            const selected = await attachSelectList(
              host.tui,
              [
                {
                  label: `${current === "ask" ? "★ " : "  "}Ask before risky actions`,
                  value: "ask",
                },
                {
                  label: `${current === "read-only" ? "★ " : "  "}Read-only — deny shell and write tools`,
                  value: "read-only",
                },
                {
                  label: `${current === "full-access" ? "★ " : "  "}Full access — auto-approve risky tools`,
                  value: "full-access",
                },
              ],
              host.editor,
              undefined,
              host.getActiveSelectListTheme(),
            );
            if (selected) {
              await applyPermissionMode(normalizePermissionMode(selected.value) ?? "ask");
            }
            break;
          }
          case "config": {
            const configPath = getThebeConfigPath();
            if (arg === "path") {
              const config = await loadThebeConfig();
              const workspacePath =
                config.workspacePath?.trim() || process.env.THEBE_WORKSPACE_DIR?.trim();
              const outputDirectory =
                config.outputDirectory?.trim() ||
                process.env.THEBE_OUTPUT_DIR?.trim() ||
                (workspacePath ? join(workspacePath, ".thebe", "outputs") : undefined);
              host.notice(
                `Thebe config: ${configPath}\nPi agent files: ${getThebeAgentDir()}\nWorkspace: ${workspacePath ?? "(not configured)"}\nDocument output: ${outputDirectory ?? "(not configured)"}`,
              );
              break;
            }
            if (arg && arg !== "edit") {
              host.notice("usage: /config or /config path");
              break;
            }

            await ensureThebeConfigFile();
            const editorCommand = getExternalEditorCommand(await loadThebeConfig());
            const [editor, ...editorArgs] = editorCommand.split(" ").filter(Boolean);
            if (!editor) {
              host.notice(`No editor configured. Edit ${configPath}`);
              break;
            }

            host.tui.stop();
            try {
              process.stdout.write(
                `Opening Thebe config with ${editorCommand}\nThebe will resume when the editor exits.\n`,
              );
              const exitCode = await new Promise<number | null>((resolve) => {
                const child = spawn(editor, [...editorArgs, configPath], {
                  stdio: "inherit",
                  shell: process.platform === "win32",
                });
                child.on("error", () => resolve(null));
                child.on("close", (code) => resolve(code));
              });
              if (exitCode !== 0) {
                host.notice(`Could not open config with ${editorCommand}. File: ${configPath}`);
              }
            } finally {
              host.tui.start();
              host.tui.setFocus(host.editor);
              host.tui.requestRender(true);
            }
            break;
          }
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
              permissionMode: agent.permissionMode(),
              autoCompact: cfg.autoCompact ?? true,
              autoSummary: agent.autoSummaryEnabled(),
              autoSummaryDelayMs: agent.autoSummaryDelayMs(),
              steeringMode: cfg.steeringMode ?? "one-at-a-time",
              followUpMode: cfg.followUpMode ?? "one-at-a-time",
              hideThinking: cfg.hideThinking ?? true,
              quietStartup: cfg.quietStartup ?? false,
              fullscreenExitOutput: cfg.fullscreenExitOutput ?? "transcript",
              fullscreenScrollbar: cfg.fullscreenScrollbar ?? "auto",
              onSettingChange: async (id, value) => {
                if (id === "theme") {
                  await host.applyTheme(value as ThemeName);
                } else if (id === "thinking") {
                  if (agent) {
                    await host.setThinkingLevel(value as ThinkingLevel);
                    host.updateFooter();
                    host.updateEditorBorderColor();
                  }
                  await saveThebeConfig({ defaultThinkingLevel: value });
                } else if (id === "tui") {
                  await saveThebeConfig({ tuiMode: value as TuiMode });
                  if (host.tui.mode !== value && host.options.onTuiModeChange) {
                    await host.options.onTuiModeChange(value as TuiMode);
                  }
                } else if (id === "permissionMode") {
                  const mode: PermissionMode =
                    value === "full-access"
                      ? "full-access"
                      : value === "read-only"
                        ? "read-only"
                        : "ask";
                  agent.setPermissionMode(mode);
                  await saveThebeConfig({ permissionMode: mode });
                  host.notice(
                    mode === "full-access"
                      ? "permission mode: full-access — approval-gated tools will run without asking"
                      : mode === "read-only"
                        ? "permission mode: read-only — shell and write tools are denied"
                        : "permission mode: ask — approval-gated tools will ask before running",
                  );
                } else if (id === "autoCompact") {
                  const enabled = value === "true";
                  await saveThebeConfig({ autoCompact: enabled });
                  if (agent && host.sessionId) {
                    try {
                      await agent.setAutoCompactionEnabled(host.sessionId, enabled);
                    } catch {}
                  }
                  host.notice(
                    enabled
                      ? "auto-compact enabled (official Pi threshold/overflow)"
                      : "auto-compact disabled",
                  );
                } else if (id === "autoSummary") {
                  const enabled = value === "true";
                  await saveThebeConfig({ autoSummary: enabled });
                  await agent.setAutoSummaryEnabled(enabled);
                  host.notice(
                    enabled ? "auto-summary enabled" : "auto-summary disabled",
                  );
                } else if (id === "autoSummaryDelay") {
                  const seconds = Number(value.replace(/s$/, ""));
                  const delayMs = seconds * 1000;
                  await saveThebeConfig({ autoSummaryDelayMs: delayMs });
                  await agent.setAutoSummaryDelayMs(delayMs);
                  host.notice(`auto-summary delay set to ${seconds}s`);
                } else if (id === "steeringMode") {
                  await saveThebeConfig({ steeringMode: value as "one-at-a-time" | "all" });
                } else if (id === "followUpMode") {
                  await saveThebeConfig({ followUpMode: value as "one-at-a-time" | "all" });
                } else if (id === "hideThinking") {
                  host.setHideThinking(value === "true");
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
