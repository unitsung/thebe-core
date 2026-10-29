import { spawn } from "node:child_process";
import { join } from "node:path";
import type { SelectItem, TuiMode } from "../rendering/adapter.ts";
import {
  PERMISSION_MODES,
  parsePermissionMode,
} from "../../../agent/runtime/interface.ts";
import type {
  PermissionMode,
  ThebeAgent,
  ThinkingLevel,
} from "../../../agent/index.ts";

const PERMISSION_MODE_SUMMARY: Record<PermissionMode, string> = {
  plan: "read-only; shell and write tools are denied",
  manual: "risky tools ask before running",
  acceptEdits:
    "edits inside the workspace and sandboxed commands run without asking",
  bypassPermissions: "nothing asks; the command guard and sandbox are lifted",
};
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

async function confirmBypass(host: SlashHost): Promise<boolean> {
  const selected = await attachSelectList(
    host.tui,
    [
      { label: "Cancel", value: "cancel" },
      {
        label: "Turn on bypassPermissions (no sandbox, no command guard)",
        value: "bypass",
      },
    ],
    host.editor,
    undefined,
    host.getActiveSelectListTheme()
  );
  return selected?.value === "bypass";
}

async function confirmSandboxOff(host: SlashHost): Promise<boolean> {
  const selected = await attachSelectList(
    host.tui,
    [
      { label: "Cancel", value: "cancel" },
      {
        label: "Turn the OS sandbox off (command guard stays on)",
        value: "off",
      },
    ],
    host.editor,
    undefined,
    host.getActiveSelectListTheme()
  );
  return selected?.value === "off";
}

export async function handleSystemCommand(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string
): Promise<boolean> {
  const persistSetting = async (
    patch: Parameters<typeof saveThebeConfig>[0]
  ): Promise<boolean> => {
    try {
      await saveThebeConfig(patch);
      return true;
    } catch (error) {
      host.notice(
        `setting was not saved: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  };
  switch (name) {
    case "permissions": {
      const applyPermissionMode = async (
        mode: PermissionMode
      ): Promise<void> => {
        if (
          mode === "bypassPermissions" &&
          agent.permissionMode() !== "bypassPermissions" &&
          !(await confirmBypass(host))
        ) {
          host.notice("bypassPermissions left off");
          return;
        }
        agent.setPermissionMode(mode);
        if (!(await persistSetting({ permissionMode: mode }))) return;
        host.notice(
          `permission mode: ${mode} — ${PERMISSION_MODE_SUMMARY[mode]}`
        );
      };
      if (arg) {
        const chosen = parsePermissionMode(arg);
        if (!chosen) {
          host.notice(
            "usage: /permissions plan|manual|acceptEdits|bypassPermissions"
          );
        } else {
          await applyPermissionMode(chosen);
        }
        break;
      }
      const current = agent.permissionMode();
      const selected = await attachSelectList(
        host.tui,
        PERMISSION_MODES.map((mode) => ({
          label: `${current === mode ? "★ " : "  "}${mode} — ${PERMISSION_MODE_SUMMARY[mode]}`,
          value: mode,
        })),
        host.editor,
        undefined,
        host.getActiveSelectListTheme()
      );
      if (selected) {
        await applyPermissionMode(
          parsePermissionMode(selected.value) ?? "manual"
        );
      }
      break;
    }
    case "config": {
      const configPath = getThebeConfigPath();
      if (arg === "path") {
        const config = await loadThebeConfig();
        const workspacePath =
          config.workspacePath?.trim() ||
          process.env.THEBE_WORKSPACE_DIR?.trim();
        const outputDirectory =
          config.outputDirectory?.trim() ||
          process.env.THEBE_OUTPUT_DIR?.trim() ||
          (workspacePath
            ? join(workspacePath, ".thebe", "outputs")
            : undefined);
        host.notice(
          `Thebe config: ${configPath}\nPi agent files: ${getThebeAgentDir()}\nWorkspace: ${workspacePath ?? "(not configured)"}\nDocument output: ${outputDirectory ?? "(not configured)"}`
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
          `Opening Thebe config with ${editorCommand}\nThebe will resume when the editor exits.\n`
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
          host.notice(
            `Could not open config with ${editorCommand}. File: ${configPath}`
          );
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
        if (!(await persistSetting({ tuiMode: chosen }))) return;
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
          `TUI mode set to "${chosen}" (saved; host did not apply a live switch)`
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
        host.getActiveSelectListTheme()
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
        sandboxEnabled: agent.getAgentSettings().sandboxEnabled,
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
            try {
              await host.applyTheme(value as ThemeName);
            } catch (error) {
              host.notice(
                `theme applied, but it was not saved: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          } else if (id === "thinking") {
            if (agent) {
              await host.setThinkingLevel(value as ThinkingLevel);
              host.updateFooter();
              host.updateEditorBorderColor();
            }
            if (!(await persistSetting({ defaultThinkingLevel: value }))) return;
          } else if (id === "tui") {
            if (!(await persistSetting({ tuiMode: value as TuiMode }))) return;
            if (host.tui.mode !== value && host.options.onTuiModeChange) {
              await host.options.onTuiModeChange(value as TuiMode);
            }
          } else if (id === "permissionMode") {
            const mode = parsePermissionMode(value) ?? "manual";
            if (
              mode === "bypassPermissions" &&
              agent.permissionMode() !== "bypassPermissions" &&
              !(await confirmBypass(host))
            ) {
              host.notice("bypassPermissions left off");
            } else {
              agent.setPermissionMode(mode);
              if (!(await persistSetting({ permissionMode: mode }))) return;
              host.notice(
                `permission mode: ${mode} — ${PERMISSION_MODE_SUMMARY[mode]}`
              );
            }
          } else if (id === "sandboxEnabled") {
            const enabled = value === "true";
            const current = agent.getAgentSettings().sandboxEnabled;
            if (!enabled && current && !(await confirmSandboxOff(host))) {
              host.notice("sandbox left on");
              return;
            }
            try {
              const next = await agent.updateAgentSettings({
                sandboxEnabled: enabled,
              });
              host.notice(
                next.sandboxEnabled
                  ? "OS sandbox on"
                  : "OS sandbox off; the command guard stays on"
              );
            } catch (error) {
              host.notice(
                error instanceof Error
                  ? error.message
                  : "sandbox setting was not changed"
              );
            }
          } else if (id === "autoCompact") {
            const enabled = value === "true";
            if (!(await persistSetting({ autoCompact: enabled }))) return;
            if (agent && host.sessionId) {
              try {
                await agent.setAutoCompactionEnabled(host.sessionId, enabled);
              } catch (error) {
                host.notice(
                  `auto-compact was saved, but this session did not accept it: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
                return;
              }
            }
            host.notice(
              enabled
                ? "auto-compact enabled (official Pi threshold/overflow)"
                : "auto-compact disabled"
            );
          } else if (id === "autoSummary") {
            const enabled = value === "true";
            if (!(await persistSetting({ autoSummary: enabled }))) return;
            await agent.setAutoSummaryEnabled(enabled);
            host.notice(
              enabled ? "auto-summary enabled" : "auto-summary disabled"
            );
          } else if (id === "autoSummaryDelay") {
            const seconds = Number(value.replace(/s$/, ""));
            const delayMs = seconds * 1000;
            if (!(await persistSetting({ autoSummaryDelayMs: delayMs }))) return;
            await agent.setAutoSummaryDelayMs(delayMs);
            host.notice(`auto-summary delay set to ${seconds}s`);
          } else if (id === "steeringMode") {
            await persistSetting({
              steeringMode: value as "one-at-a-time" | "all",
            });
          } else if (id === "followUpMode") {
            await persistSetting({
              followUpMode: value as "one-at-a-time" | "all",
            });
          } else if (id === "hideThinking") {
            host.setHideThinking(value === "true");
          } else if (id === "quietStartup") {
            await persistSetting({ quietStartup: value === "true" });
          } else if (id === "fullscreenExitOutput") {
            await persistSetting({
              fullscreenExitOutput: value as "transcript" | "resume-hint",
            });
          } else if (id === "fullscreenScrollbar") {
            await persistSetting({
              fullscreenScrollbar: value as "auto" | "always" | "hidden",
            });
          }
        },
      });
      break;
    }
    case "theme": {
      if (arg) {
        if (arg === "dark" || arg === "light") {
          try {
            await host.applyTheme(arg);
            host.notice(`theme set to ${arg}`);
          } catch (error) {
            host.notice(
              `theme applied, but it was not saved: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          host.notice("usage: /theme dark|light");
        }
        break;
      }
      const previous = host.currentTheme;
      const items: SelectItem[] = [
        {
          label: `${host.currentTheme === "dark" ? "★ " : "  "}Dark theme`,
          value: "dark",
        },
        {
          label: `${host.currentTheme === "light" ? "★ " : "  "}Light theme`,
          value: "light",
        },
      ];
      const selected = await attachSelectList(
        host.tui,
        items,
        host.editor,
        (item) => {
          void host.applyTheme(item.value as ThemeName, false);
        },
        host.getActiveSelectListTheme()
      );
      if (selected) {
        const chosen = selected.value as ThemeName;
        try {
          await host.applyTheme(chosen);
          host.notice(`theme set to ${chosen}`);
        } catch (error) {
          host.notice(
            `theme applied, but it was not saved: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
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
