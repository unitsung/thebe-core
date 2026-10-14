import { randomUUID } from "node:crypto";
import type { PermissionRequest, RuntimeMcpOptions, RuntimeMcpServer } from "../../../agent/runtime/interface.ts";
import { REDACTED, redactToolOutput, summarizeArgs } from "../../../agent/security/redaction.ts";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { mcpServerEnv } from "../../mcp/env.ts";
import { fenceToolOutput } from "../../../agent/security/untrusted-fence.ts";
import type { PiSdk } from "../sdk/load-pi.ts";

type Hints = { readOnlyHint?: boolean } | undefined;
type ResultBlock = { type: string; text?: string };

type GuardPi = {
  on(event: string, handler: (event: any) => unknown): void;
  getAllTools(): Array<{ name: string; annotations?: Hints }>;
};

type PermissionPort = {
  preflight(request: PermissionRequest): Promise<"allow" | "deny" | "ask">;
  request(request: PermissionRequest): Promise<"allow" | "deny">;
};

/** Pi's MCP config shape for the servers Core hands to the runtime. */
export function toPiMcpConfig(servers: readonly RuntimeMcpServer[]) {
  return {
    servers: servers.map((server) => ({
      name: server.name,
      source: "thebe://mcp",
      scope: "extension" as const,
      config: {
        ...(server.command
          ? { type: "stdio" as const, command: server.command, args: server.args, env: server.env }
          : { type: "http" as const, url: server.url ?? "", headers: server.headers }),
        enabled: server.enabled,
        ...(server.description ? { description: server.description } : {}),
        ...(server.exposure ? { exposure: server.exposure } : {}),
      },
    })),
    errors: [] as string[],
  };
}

function redactBlocks(blocks: ResultBlock[], wrap?: string): { blocks: ResultBlock[]; redacted: boolean } {
  let redacted = false;
  const next = blocks.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const text = redactToolOutput(block.text);
    if (text.includes(REDACTED)) redacted = true;
    return { ...block, text: wrap ? fenceToolOutput(wrap, text) : text };
  });
  return { blocks: next, redacted };
}

/**
 * Guards for the runtime's own MCP client: policy, approval, audit and redaction ride on Pi's
 * `tool_call` and `tool_result` hooks, which also see calls made from a codemode script.
 */
export function createMcpGuardExtension(sdk: PiSdk, mcp: RuntimeMcpOptions, permission?: PermissionPort) {
  const started = new Map<string, number>();
  const serverFor = (toolName: string): RuntimeMcpServer | undefined =>
    mcp.servers().find((server) => toolName.startsWith(`${sdk.mcpNamespace(server.name)}__`));

  return (pi: GuardPi): void => {
    pi.on("tool_call", async (event: { toolName: string; toolCallId?: string; input?: unknown }) => {
      if (!sdk.isMcpToolName(event.toolName)) return undefined;
      const toolCallId = event.toolCallId ?? randomUUID();
      const call = { toolName: event.toolName, toolCallId, input: event.input };
      const blocked = await mcp.beforeCall(call);
      if (blocked) return { block: true, reason: blocked.block };
      started.set(toolCallId, Date.now());

      const server = serverFor(event.toolName);
      if (!server) return undefined; // MCP resource tools only read.
      const hints = pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations;
      const needsApproval = server.permission ? server.permission !== "read" : hints?.readOnlyHint !== true;
      if (!needsApproval || !permission) return undefined;

      const request: PermissionRequest = {
        permissionId: randomUUID(),
        toolName: event.toolName,
        toolCallId,
        args: event.input,
        argsSummary: summarizeArgs(event.input),
        risk: "high",
      };
      const preflight = await permission.preflight(request);
      if (preflight === "allow") return undefined;
      if (preflight === "deny") return { block: true, reason: "denied by policy" };
      return (await permission.request(request)) === "allow" ? undefined : { block: true, reason: "denied by user" };
    });

    pi.on("tool_result", async (event: {
      toolName: string; toolCallId: string; parentToolCallId?: string;
      content: ResultBlock[]; isError: boolean; input?: unknown; structuredContent?: unknown;
    }) => {
      const isMcp = sdk.isMcpToolName(event.toolName);
      if (!isMcp && event.toolName !== "codemode") return undefined;
      // A direct call is fenced as untrusted data. A nested call hands raw data to a script, whose own
      // result is fenced when the script finishes.
      const direct = event.parentToolCallId === undefined;
      const { blocks, redacted } = redactBlocks(event.content, direct ? event.toolName : undefined);
      const structured = event.structuredContent === undefined ? undefined : redactStructured(event.structuredContent);
      if (isMcp) {
        const startedAt = started.get(event.toolCallId);
        started.delete(event.toolCallId);
        const text = blocks.map((block) => block.text ?? "").join("\n");
        await mcp.afterCall(
          { toolName: event.toolName, toolCallId: event.toolCallId, input: event.input },
          { bytes: Buffer.byteLength(text), isError: event.isError, redacted, durationMs: startedAt ? Date.now() - startedAt : 0 },
        );
      }
      return { content: blocks, ...(structured === undefined ? {} : { structuredContent: structured }) };
    });
  };
}

function redactStructured(value: unknown): unknown {
  if (typeof value === "string") return redactToolOutput(value);
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(password|token|secret|api_?key|credential)$/i.test(key) ? REDACTED : redactStructured(item)]));
  }
  return value;
}

/**
 * Pi starts stdio servers with Core's whole environment. Core's holds credentials, so stdio servers
 * get a minimal one here; HTTP servers keep Pi's own transport.
 */
export function createMcpTransportFactory(sdk: PiSdk) {
  return ((entry: { config: Record<string, any>; name: string }, cwd: string, authProvider: unknown) => {
    const config = entry.config;
    if (!("command" in config)) return sdk.createDefaultMcpTransport(entry as never, cwd, authProvider as never);
    return new StdioTransport({
      command: config.command, args: config.args, cwd, env: mcpServerEnv(config.env),
      inheritEnv: false, stderr: "pipe",
    });
  }) as never;
}
