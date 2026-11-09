import type { ThebeAgent } from "../../../agent/index.ts";
import type { SlashHost } from "./context.ts";
import { handleMcpCommand } from "./extensions/mcp.ts";
import { handleSkillsCommand } from "./extensions/skills.ts";
import { handleSubagentCommand } from "./subagents.ts";
import type { ThebeOAuthConnection } from "../types.ts";

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
    case "connections":
      await manageOAuthConnections(host, arg);
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

async function manageOAuthConnections(
  host: SlashHost,
  arg: string
): Promise<void> {
  const connectors = host.options.oauthConnectors;
  if (!connectors) {
    host.notice(
      "MCP OAuth is not enabled; set THEBE_OAUTH_ISSUER and restart Thebe."
    );
    return;
  }
  const [action, id, ...extra] = arg.split(/\s+/).filter(Boolean);
  if (action && action !== "list" && action !== "revoke") {
    host.notice("usage: /connections [list | revoke <grantId>]");
    return;
  }
  if (action === "revoke") {
    if (!id || extra.length > 0) {
      host.notice("usage: /connections revoke <grantId>");
      return;
    }
    const revoked = await connectors.revoke(id);
    host.notice(
      revoked
        ? `Revoked OAuth connector ${id}. It must authorize again to reconnect.`
        : `No OAuth connector grant has id ${id}.`
    );
    return;
  }
  const connections = await connectors.list();
  if (connections.length === 0) {
    host.notice("No MCP OAuth connectors are connected.");
    return;
  }
  host.notice(connections.map(connectionText).join("\n\n"));
}

function connectionText(connection: ThebeOAuthConnection): string {
  return [
    `${connection.clientName} - ${connection.id}`,
    `Client: ${connection.clientId}`,
    `Scopes: ${connection.scopes.join(", ") || "(none)"}`,
    `Created: ${connection.createdAt}`,
    ...(connection.expiresAt ? [`Expires: ${connection.expiresAt}`] : []),
    `Refresh token: ${connection.refreshToken ? "yes" : "no"}`,
  ].join("\n");
}
