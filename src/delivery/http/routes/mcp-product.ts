import { EXTERNAL_CAPABILITY_SOURCE } from "../../../agent/extensions/mcp.ts";
import {
  toProductCapability,
  toProductMcpServer,
} from "../../../agent/extensions/product.ts";
import { agentUnavailable, quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError, invalidBody, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH, PRODUCT_HTTP_SEGMENT } from "../product-paths.ts";

export async function handleMcpProductRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.path.startsWith(PRODUCT_HTTP_PATH.mcpExtensions)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, parts, agent } = context;
  try {
    if (request.method === "POST" && parts.length === 4 && parts[3] === PRODUCT_HTTP_SEGMENT.servers) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const body = await readJson(request);
      if (typeof body.name !== "string" || (body.url !== undefined && typeof body.url !== "string") || (body.command !== undefined && typeof body.command !== "string")) {
        return invalidBody("name, url and command must be strings");
      }
      const input = { name: body.name, url: body.url as string | undefined, command: body.command as string | undefined,
        args: body.args as string[] | undefined, env: body.env as Record<string, string> | undefined,
        headers: body.headers as Record<string, string> | undefined };
      try { return json(toProductMcpServer(await agent.addMcpServer(input)), 201); }
      catch (error) { return invalidBody(error instanceof Error ? error.message : "MCP registration failed"); }
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === PRODUCT_HTTP_SEGMENT.servers) {
      const servers = (await agent.listMcpServers()).map(toProductMcpServer);
      return json({ servers });
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === PRODUCT_HTTP_SEGMENT.tools) {
      const tools = (await agent.listMcpTools())
        .filter((tool) => tool.source === EXTERNAL_CAPABILITY_SOURCE)
        .map(toProductCapability);
      return json({ tools });
    }
    if (
      request.method === "PATCH" &&
      parts.length === 5 &&
      parts[3] === PRODUCT_HTTP_SEGMENT.servers
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const name = decodeURIComponent(parts[4] ?? "");
      if (!name) return undefined;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        return invalidBody("enabled must be a boolean");
      }
      const server = await agent.setMcpServerEnabled(name, body.enabled);
      if (!server) return notFound("MCP server not found");
      return json(toProductMcpServer(server));
    }
    if (
      request.method === "DELETE" &&
      parts.length === 5 &&
      parts[3] === PRODUCT_HTTP_SEGMENT.servers
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const name = decodeURIComponent(parts[4] ?? "");
      if (!name) return undefined;
      if (!(await agent.removeMcpServer(name))) return notFound("MCP server not found");
      return json({ ok: true });
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}
