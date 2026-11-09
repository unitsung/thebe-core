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
  arg: string
): Promise<boolean> {
  switch (name) {
    case "skills":
    case "skill":
      return handleSkillsCommand(host, agent, arg);
    case "mcp":
      return handleMcpCommand(host, agent, arg);
    case "pair":
      await issuePairingCode(host, arg);
      return true;
    case "subagent":
    case "subagents":
      return handleSubagentCommand(host, agent, arg);
    default:
      return false;
  }
}

async function issuePairingCode(host: SlashHost, arg: string): Promise<void> {
  if (arg) {
    host.notice("usage: /pair");
    return;
  }
  const issue = host.options.issueOAuthPairingCode;
  if (!issue) {
    host.notice(
      "MCP OAuth is not enabled; set THEBE_OAUTH_ISSUER and restart Thebe."
    );
    return;
  }
  const pairing = await issue();
  const route = pairing.issuer
    ? `\nIssuer: ${pairing.issuer}${pairing.resource ? `\nResource: ${pairing.resource}` : ""}`
    : "";
  host.notice(
    `OAuth pairing code: ${pairing.code}\nExpires: ${pairing.expiresAt}${route}`
  );
}
