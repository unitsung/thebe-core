import type { ThebeAgent } from "../../../agent/index.ts";
import type { SlashHost } from "./context.ts";
import { handleMcpCommand } from "./extensions/mcp.ts";
import { handleSkillsCommand } from "./extensions/skills.ts";
import { handleSubagentCommand } from "./subagents.ts";

/** Dispatches extension commands to their delivery modules. */
export async function handleThebeCommand(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
    case "skills":
    case "skill":
      return handleSkillsCommand(host, agent, arg);
    case "mcp":
      return handleMcpCommand(host, agent, arg);
    case "subagent":
    case "subagents":
      return handleSubagentCommand(host, agent, arg);
    default:
      return false;
  }
}
