import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";
import {
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
  CONTAINER_TOOL_SCHEMAS,
} from "../capabilities/containers.ts";
import { createToolLayer } from "./tool-layer.ts";

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
      parameters: CONTAINER_TOOL_SCHEMAS["container.list"],
      execute: run("container.list"),
    },
    {
      name: "container.inspect",
      label: "Inspect container",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.inspect"],
      parameters: CONTAINER_TOOL_SCHEMAS["container.inspect"],
      execute: run("container.inspect"),
    },
    {
      name: "container.logs",
      label: "Container logs",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.logs"],
      parameters: CONTAINER_TOOL_SCHEMAS["container.logs"],
      execute: run("container.logs"),
    },
    {
      name: "container.status_summary",
      label: "Container status summary",
      description: CONTAINER_TOOL_DESCRIPTIONS["container.status_summary"],
      parameters: CONTAINER_TOOL_SCHEMAS["container.status_summary"],
      execute: run("container.status_summary"),
    },
  ];
}
