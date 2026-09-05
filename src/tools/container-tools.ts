import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { hashParameters } from "../audit/audit-log.ts";
import type { createAuditLog } from "../audit/audit-log.ts";
import type { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { REDACTED, TRUNCATION_MARKER } from "../redaction.ts";
import { createToolLayer } from "./tool-layer.ts";

const emptyParams = Type.Object({});
const idParams = Type.Object({
  id: Type.String({ description: "Container id" }),
});
const logsParams = Type.Object({
  id: Type.String({ description: "Container id" }),
  tail: Type.Optional(Type.Number({ description: "Max log lines" })),
});

export const CONTAINER_TOOL_NAMES = [
  "container.list",
  "container.inspect",
  "container.logs",
  "container.status_summary",
] as const;

type Policy = ReturnType<typeof createPolicyEngine>;
type Audit = ReturnType<typeof createAuditLog>;

export function createContainerTools(
  provider: ContainerInfoProvider,
  options: {
    policy: Policy;
    audit?: Audit;
    callerId: string;
  },
): AgentTool[] {
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
      const result = await layer.invoke(name, args);
      const text = JSON.stringify(result);
      await options.audit?.append({
        method: name,
        parameterHash: hashParameters(args),
        responseBytes: Buffer.byteLength(text),
        budgetConsumed: decision.budgetConsumed,
        redactionFired:
          text.includes(REDACTED) || text.includes(TRUNCATION_MARKER),
      });
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    };

  return [
    {
      name: "container.list",
      label: "List containers",
      description: "List container summaries in the configured environment",
      parameters: emptyParams,
      execute: run("container.list"),
    },
    {
      name: "container.inspect",
      label: "Inspect container",
      description: "Inspect one container (env already redacted)",
      parameters: idParams,
      execute: run("container.inspect"),
    },
    {
      name: "container.logs",
      label: "Container logs",
      description: "Read recent container logs (redacted and truncated)",
      parameters: logsParams,
      execute: run("container.logs"),
    },
    {
      name: "container.status_summary",
      label: "Container status summary",
      description: "Host-level container counts",
      parameters: emptyParams,
      execute: run("container.status_summary"),
    },
  ];
}
