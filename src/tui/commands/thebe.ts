import type { ThebeProduct } from "../../product/service.ts";
import { attachPromptInput, attachSelectList } from "../overlays/index.ts";
import type { SlashHost } from "./context.ts";

export async function handleThebeCommand(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  const renderSubagentList = (runs: Awaited<ReturnType<ThebeProduct["listSubagents"]>>): void => {
    host.notice(
      runs.length === 0
        ? "no subagent runs"
        : runs
            .map(
              (run) =>
                `${run.runId.slice(0, 8)} · ${run.profileName} · ${run.status} · ${run.turns}/${run.maxTurns} · ${run.task}`,
            )
            .join("\n"),
    );
  };

  const watchSubagent = (run: Awaited<ReturnType<ThebeProduct["spawnSubagent"]>>): void => {
    void product.waitSubagent(run.runId).then((completed) => {
      if (completed.status === "completed") {
        host.notice(`subagent ${completed.profileName} completed`);
        if (completed.result) {
          host.insertBeforeFooter(
            host.makeMarkdown(
              `### Subagent result · ${completed.profileName}\n\n${completed.result}`,
            ),
          );
          host.tui.requestRender();
        }
      } else if (completed.status === "cancelled") {
        host.notice(`subagent ${completed.profileName} cancelled`);
      } else {
        host.notice(
          `subagent ${completed.profileName} failed: ${completed.error ?? "unknown error"}`,
        );
      }
    }).catch((error) => {
      host.notice(`subagent failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  switch (name) {
          case "skills":
          case "skill": {
            const [action, ...rest] = arg.split(/\s+/).filter(Boolean);
            const skillName = rest.join(" ");
            if (action === "list" || (!action && arg === "list")) {
              const skills = await product.listSkills();
              if (skills.length === 0) {
                host.notice("no skills found in .thebe/skills or .pi/skills (project/global)");
                break;
              }
              host.notice(
                skills
                  .map(
                    (skill) =>
                      `${skill.enabled ? "[✓]" : "[ ]"} ${skill.name} (${skill.scope}) — ${skill.description}`,
                  )
                  .join("\n"),
              );
              break;
            }
            if (action === "enable" && skillName) {
              await product.enableSkill(skillName);
              host.notice(`enabled skill ${skillName}`);
              break;
            }
            if (action === "disable" && skillName) {
              await product.disableSkill(skillName);
              host.notice(`disabled skill ${skillName}`);
              break;
            }
            const skills = await product.listSkills();
            if (skills.length === 0) {
              host.notice("no skills found in .thebe/skills or .pi/skills (project/global)");
              break;
            }
            const picked = await attachSelectList(
              host.tui,
              skills.map((skill) => ({
                label: `${skill.enabled ? "[✓]" : "[ ]"} ${skill.name} (${skill.scope}) — ${skill.description}`,
                value: skill.name,
              })),
              host.editor,
              undefined,
              host.getActiveSelectListTheme(),
            );
            if (!picked) break;
            const skill = await product.getSkill(picked.value);
            if (!skill) break;
            const actionItem = await attachSelectList(
              host.tui,
              [
                {
                  label: skill.enabled ? "Disable skill" : "Enable skill",
                  value: "toggle",
                },
                { label: "View instructions", value: "view" },
              ],
              host.editor,
              undefined,
              host.getActiveSelectListTheme(),
            );
            if (!actionItem) break;
            if (actionItem.value === "toggle") {
              if (skill.enabled) {
                await product.disableSkill(skill.name);
                host.notice(`disabled skill ${skill.name}`);
              } else {
                await product.enableSkill(skill.name);
                host.notice(`enabled skill ${skill.name}`);
              }
            } else {
              host.notice(
                `--- ${skill.name} ---\n${(skill.content ?? "").trim() || "(empty skill)"}`,
              );
            }
            break;
          }
          case "mcp": {
            const [action, toolName, ...rest] = arg.split(/\s+/).filter(Boolean);
            const argsJson = rest.join(" ");
            if (action === "list" || !action) {
              if (action === "list" || arg === "" || arg === "list") {
                const tools = await product.listMcpTools();
                const servers = await product.listMcpServers();
                const toolLines = tools.map(
                  (tool) =>
                    `${tool.source === "core" ? "[core]" : "[ext]"} ${tool.name} — ${tool.description}`,
                );
                const serverLines =
                  servers.length === 0
                    ? ["(no external MCP servers in mcp.json)"]
                    : servers.map(
                        (server) =>
                          `${server.status === "ready" ? "[ready]" : server.status === "error" ? "[error]" : server.disabled ? "[disabled]" : "[configured]"} ${server.name}${server.command ? ` · ${server.command}` : ""}${server.url ? ` · ${server.url}` : ""}${server.toolCount ? ` · ${server.toolCount} tools` : ""}${server.error ? ` · ${server.error}` : ""}`,
                      );
                if (!action) {
                  const picked = await attachSelectList(
                    host.tui,
                    [
                      { label: "List MCP tools", value: "list" },
                      { label: "View MCP servers", value: "servers" },
                    ],
                    host.editor,
                    undefined,
                    host.getActiveSelectListTheme(),
                  );
                  if (!picked) break;
                  if (picked.value === "list") {
                    host.notice(toolLines.join("\n"));
                    break;
                  }
                  if (picked.value === "servers") {
                    host.notice(serverLines.join("\n"));
                    break;
                  }
                  break;
                }
                host.notice(toolLines.join("\n"));
                break;
              }
            }
            if (action === "servers") {
              const servers = await product.listMcpServers();
              host.notice(
                servers.length === 0
                  ? "(no external MCP servers in mcp.json)"
                  : servers
                      .map(
                        (server) =>
                          `${server.status === "ready" ? "[ready]" : server.status === "error" ? "[error]" : server.disabled ? "[disabled]" : "[configured]"} ${server.name}${server.command ? ` · ${server.command}` : ""}${server.url ? ` · ${server.url}` : ""}${server.toolCount ? ` · ${server.toolCount} tools` : ""}${server.error ? ` · ${server.error}` : ""}`,
                      )
                      .join("\n"),
              );
              break;
            }
            if (action === "call") {
              if (!toolName) {
                host.notice("usage: /mcp call <toolName> [argsJson]");
                break;
              }
              let parsed: unknown = {};
              if (argsJson) {
                try {
                  parsed = JSON.parse(argsJson);
                } catch {
                  host.notice("invalid JSON arguments");
                  break;
                }
              }
              try {
                const result = await product.invokeTool(toolName, parsed);
                host.notice(`MCP ${toolName}:\n${result}`);
              } catch (err) {
                host.notice(
                  `MCP call failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              break;
            }
            host.notice("usage: /mcp list|call|servers");
            break;
          }
          case "subagent":
          case "subagents": {
            const [action, profileName, ...rest] = arg.split(/\s+/).filter(Boolean);
            const task = rest.join(" ");
            if (action === "list" || arg === "list") {
              const id = host.sessionId ?? product.lastThebeSessionId();
              const kids = await product.listSubagents(id);
              renderSubagentList(kids);
              break;
            }
            if (action === "profiles") {
              const profiles = await product.listSubagentProfiles();
              if (profiles.length === 0) {
                host.notice("no subagent profiles found");
                break;
              }
              host.notice(
                profiles
                  .map(
                    (profile) =>
                      `${profile.name} (${profile.scope}) — ${profile.description}`,
                  )
                  .join("\n"),
              );
              break;
            }
            if (action === "spawn") {
              if (!profileName || !task) {
                host.notice("usage: /subagent spawn <profile> <task>");
                break;
              }
              const parentId = host.ensureSession();
              const run = await product.spawnSubagent({
                profileName,
                taskPrompt: task,
                parentSessionId: parentId,
              });
              host.notice(`subagent ${run.runId.slice(0, 8)} ${run.status}`);
              watchSubagent(run);
              break;
            }
            if (action === "cancel") {
              if (!profileName) {
                host.notice("usage: /subagent cancel <runId>");
                break;
              }
              const cancelled = await product.cancelSubagent(
                profileName,
                host.sessionId ?? product.lastThebeSessionId(),
              );
              host.notice(`subagent ${cancelled.runId.slice(0, 8)} ${cancelled.status}`);
              break;
            }
            const picked = await attachSelectList(
              host.tui,
              [
                { label: "List subagent runs", value: "list" },
                { label: "Spawn subagent from profile", value: "spawn" },
                { label: "Cancel a subagent run", value: "cancel" },
                { label: "View profiles", value: "profiles" },
              ],
              host.editor,
              undefined,
              host.getActiveSelectListTheme(),
            );
            if (!picked) break;
            if (picked.value === "list") {
              const id = host.sessionId ?? product.lastThebeSessionId();
              const kids = await product.listSubagents(id);
              renderSubagentList(kids);
              break;
            }
            if (picked.value === "cancel") {
              const runId = await attachPromptInput(host.tui, {
                prompt: "Run ID: ",
                placeholder: "paste the run ID or its first 8 characters",
                focusBack: host.editor,
              });
              if (!runId?.trim()) break;
              const cancelled = await product.cancelSubagent(
                runId.trim(),
                host.sessionId ?? product.lastThebeSessionId(),
              );
              host.notice(`subagent ${cancelled.runId.slice(0, 8)} ${cancelled.status}`);
              break;
            }
            if (picked.value === "profiles") {
              const profiles = await product.listSubagentProfiles();
              host.notice(
                profiles.length === 0
                  ? "no subagent profiles found"
                  : profiles
                      .map(
                        (profile) =>
                          `${profile.name} (${profile.scope}) — ${profile.description}`,
                      )
                      .join("\n"),
              );
              break;
            }
            const profiles = await product.listSubagentProfiles();
            if (profiles.length === 0) {
              host.notice("no subagent profiles found");
              break;
            }
            const profilePick = await attachSelectList(
              host.tui,
              profiles.map((profile) => ({
                label: `${profile.name} — ${profile.description}`,
                value: profile.name,
              })),
              host.editor,
              undefined,
              host.getActiveSelectListTheme(),
            );
            if (!profilePick) break;
            const taskText = await attachPromptInput(host.tui, {
              prompt: "Task: ",
              placeholder: "required task for the subagent",
              focusBack: host.editor,
            });
            if (taskText === null) break;
            if (!taskText.trim()) {
              host.notice("subagent task cannot be empty");
              break;
            }
            const parentId = host.ensureSession();
            const run = await product.spawnSubagent({
              profileName: profilePick.value,
              taskPrompt: taskText.trim(),
              parentSessionId: parentId,
            });
            host.notice(`subagent ${run.runId.slice(0, 8)} ${run.status}`);
            watchSubagent(run);
            break;
          }
    default:
      return false;
  }
  return true;
}
