import type { ThebeProduct } from "../../product/service.ts";
import { attachPromptInput, attachSelectList } from "../overlays/index.ts";
import type { SlashHost } from "./context.ts";

export async function handleThebeCommand(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
          case "skills":
          case "skill": {
            const [action, ...rest] = arg.split(/\s+/).filter(Boolean);
            const skillName = rest.join(" ");
            if (action === "list" || (!action && arg === "list")) {
              const skills = await product.listSkills();
              if (skills.length === 0) {
                host.notice("no skills found in .thebe/skills or ~/.thebe/skills");
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
              host.notice("no skills found in .thebe/skills or ~/.thebe/skills");
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
                          `${server.name}${server.command ? ` · ${server.command}` : ""}${server.url ? ` · ${server.url}` : ""}`,
                      );
                if (!action) {
                  const picked = await attachSelectList(
                    host.tui,
                    [
                      { label: "List MCP tools", value: "list" },
                      { label: "Test MCP tool", value: "call" },
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
                  const toolPick = await attachSelectList(
                    host.tui,
                    tools.map((tool) => ({
                      label: `${tool.name} — ${tool.description}`,
                      value: tool.name,
                    })),
                    host.editor,
                    undefined,
                    host.getActiveSelectListTheme(),
                  );
                  if (!toolPick) break;
                  try {
                    const result = await product.invokeTool(toolPick.value, {});
                    host.notice(`MCP ${toolPick.value}:\n${result}`);
                  } catch (err) {
                    host.notice(
                      `MCP call failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
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
                          `${server.name}${server.command ? ` · ${server.command}` : ""}${server.url ? ` · ${server.url}` : ""}`,
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
              if (kids.length === 0) {
                host.notice("no active subagents");
                break;
              }
              host.notice(
                kids
                  .map(
                    (kid) =>
                      `${kid.thebeSessionId.slice(0, 8)} — ${kid.title || "untitled"} [${kid.streaming ? "streaming" : kid.status}]`,
                  )
                  .join("\n"),
              );
              break;
            }
            if (action === "profiles") {
              const profiles = await product.listSubagentProfiles();
              if (profiles.length === 0) {
                host.notice("no subagent profiles in .thebe/agents or ~/.thebe/agents");
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
              if (!profileName) {
                host.notice("usage: /subagent spawn <profile> [task]");
                break;
              }
              const parentId = host.ensureSession();
              const meta = await product.spawnSubagent({
                profileName,
                taskPrompt: task || undefined,
                parentSessionId: parentId,
              });
              host.notice(`spawned subagent ${meta.thebeSessionId} from profile ${profileName}`);
              break;
            }
            const picked = await attachSelectList(
              host.tui,
              [
                { label: "List active subagents", value: "list" },
                { label: "Spawn subagent from profile", value: "spawn" },
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
              host.notice(
                kids.length === 0
                  ? "no active subagents"
                  : kids
                      .map(
                        (kid) =>
                          `${kid.thebeSessionId.slice(0, 8)} — ${kid.title || "untitled"} [${kid.streaming ? "streaming" : kid.status}]`,
                      )
                      .join("\n"),
              );
              break;
            }
            if (picked.value === "profiles") {
              const profiles = await product.listSubagentProfiles();
              host.notice(
                profiles.length === 0
                  ? "no subagent profiles in .thebe/agents or ~/.thebe/agents"
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
              host.notice("no subagent profiles in .thebe/agents or ~/.thebe/agents");
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
              placeholder: "optional task for the subagent",
              focusBack: host.editor,
            });
            if (taskText === null) break;
            const parentId = host.ensureSession();
            const meta = await product.spawnSubagent({
              profileName: profilePick.value,
              taskPrompt: taskText.trim() || undefined,
              parentSessionId: parentId,
            });
            host.notice(`spawned subagent ${meta.thebeSessionId} from profile ${profilePick.value}`);
            break;
          }
    default:
      return false;
  }
  return true;
}
