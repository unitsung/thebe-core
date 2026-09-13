import type { ThebeAgent } from "../../../../agent/index.ts";
import { attachSelectList } from "../../overlays/index.ts";
import type { SlashHost } from "../context.ts";

function serverLines(agent: ThebeAgent): Promise<string[]> {
  return agent.listMcpServers().then((servers) => servers.length === 0
    ? ["(no external MCP servers in mcp.json)"]
    : servers.map((server) => {
      const status = server.status === "ready" ? "[ready]"
        : server.status === "error" ? "[error]"
          : server.disabled ? "[disabled]" : "[configured]";
      return `${status} ${server.name}${server.command ? ` · ${server.command}` : ""}${server.url ? ` · ${server.url}` : ""}${server.toolCount ? ` · ${server.toolCount} tools` : ""}${server.error ? ` · ${server.error}` : ""}`;
    }));
}

export async function handleMcpCommand(host: SlashHost, agent: ThebeAgent, arg: string): Promise<boolean> {
  const [action, toolName, ...rest] = arg.split(/\s+/).filter(Boolean);
  const argsJson = rest.join(" ");
  if (action === "list" || !action) {
    const tools = await agent.listMcpTools();
    const toolsText = tools.map((tool) => `${tool.source === "core" ? "[core]" : "[ext]"} ${tool.name} — ${tool.description}`).join("\n");
    if (!action) {
      const picked = await attachSelectList(
        host.tui,
        [{ label: "List MCP tools", value: "list" }, { label: "View MCP servers", value: "servers" }],
        host.editor,
        undefined,
        host.getActiveSelectListTheme(),
      );
      if (!picked) return true;
      host.notice(picked.value === "list" ? toolsText : (await serverLines(agent)).join("\n"));
      return true;
    }
    host.notice(toolsText);
    return true;
  }
  if (action === "servers") {
    host.notice((await serverLines(agent)).join("\n"));
    return true;
  }
  if (action === "call") {
    if (!toolName) {
      host.notice("usage: /mcp call <toolName> [argsJson]");
      return true;
    }
    let parsed: unknown = {};
    if (argsJson) {
      try { parsed = JSON.parse(argsJson); } catch {
        host.notice("invalid JSON arguments");
        return true;
      }
    }
    try {
      const result = await agent.invokeTool(toolName, parsed);
      host.notice(`MCP ${toolName}:\n${result}`);
    } catch (error) {
      host.notice(`MCP call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }
  host.notice("usage: /mcp list|call|servers");
  return true;
}
