import { hashParameters } from "../audit/audit-log.ts";
import type { createAuditLog } from "../audit/audit-log.ts";
import type { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import type { CustomToolDefinition } from "../runtime/types.ts";
import { REDACTED, TRUNCATION_MARKER } from "./redaction.ts";
import { createToolLayer } from "./tool-layer.ts";

const emptyParams = {
  type: "object",
  properties: {},
};
const idParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Container id" },
  },
  required: ["id"],
};
const logsParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Container id" },
    tail: { type: "number", description: "Max log lines" },
  },
  required: ["id"],
};

export const CONTAINER_TOOL_NAMES = [
  "container.list",
  "container.inspect",
  "container.logs",
  "container.status_summary",
] as const;

export const CONTAINER_TOOL_DESCRIPTIONS: Record<
  (typeof CONTAINER_TOOL_NAMES)[number],
  string
> = {
  "container.list": "List container summaries in the configured environment",
  "container.inspect": "Inspect one container (env already redacted)",
  "container.logs": "Read recent container logs (redacted and truncated)",
  "container.status_summary": "Host-level container counts",
};

type Policy = ReturnType<typeof createPolicyEngine>;
type Audit = ReturnType<typeof createAuditLog>;

export function createContainerTools(
  provider: ContainerInfoProvider,
  options: {
    policy: Policy;
    audit?: Audit;
    callerId: string;
  },
): CustomToolDefinition[] {
  const layer = createToolLayer(provider);

  const run = (name: (typeof CONTAINER_TOOL_NAMES)[number]) =>
    async (_toolCallId: string, params: unknown) => {
      const args = (params ?? {}) as { id?: string; tail?: number };
      const decision = options.policy.allow(name, options.callerId);
      if (!decision.ok) {
        await options.audit?.append({
          method: name,
          parameterHash: hashParameters(args),
          responseBytes: 0,
          budgetConsumed: 0,
          redactionFired: false,
        });
        throw new Error(decision.reason);
      }
      try {
        const result = await layer.invoke(name, args);
        const text = JSON.stringify(result);
        await options.audit?.append({
          method: name,
          parameterHash: hashParameters(args),
          responseBytes: Buffer.byteLength(text),
          budgetConsumed: decision.budgetConsumed,
          redactionFired:
            text.includes(REDACTED) || text.includes(TRUNCATION_MARKER),
          result: "ok",
        });
        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.audit?.append({
          method: name,
          parameterHash: hashParameters(args),
          responseBytes: 0,
          budgetConsumed: decision.budgetConsumed,
          redactionFired: false,
          result: "error",
        });
        throw new Error(message);
      }
    };

  return [
    {
      name: "container.list",
      label: "List containers",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.list"],
      parameters: emptyParams,
      execute: run("container.list"),
    },
    {
      name: "container.inspect",
      label: "Inspect container",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.inspect"],
      parameters: idParams,
      execute: run("container.inspect"),
    },
    {
      name: "container.logs",
      label: "Container logs",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.logs"],
      parameters: logsParams,
      execute: run("container.logs"),
    },
    {
      name: "container.status_summary",
      label: "Container status summary",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.status_summary"],
      parameters: emptyParams,
      execute: run("container.status_summary"),
    },
  ];
}
