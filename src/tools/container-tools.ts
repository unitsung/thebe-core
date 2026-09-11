import type { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import type { CustomToolDefinition } from "../runtime/types.ts";
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

export function createContainerTools(
  provider: ContainerInfoProvider,
  options: {
    policy: Policy;
    callerId: string;
  },
): CustomToolDefinition[] {
  const layer = createToolLayer(provider);

  const run = (name: (typeof CONTAINER_TOOL_NAMES)[number]) =>
    async (_toolCallId: string, params: unknown) => {
      const args = (params ?? {}) as { id?: string; tail?: number };
      const decision = options.policy.allow(name, options.callerId);
      if (!decision.ok) {
        throw new Error(decision.reason);
      }
      try {
        const result = await layer.invoke(name, args);
        const text = JSON.stringify(result);
        return {
          content: [{ type: "text" as const, text }],
          details: {},
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
