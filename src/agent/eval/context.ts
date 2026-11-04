import type { CustomToolDefinition } from "../runtime/index.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import type { createAuditLog } from "../security/audit/audit-log.ts";
import { wrapCustomTools } from "../tools/wrapped-tool.ts";
import type { Trigger } from "../sources/types.ts";

/** Read-only context about the resource, as text for the model, and the tools it came from. */
export type AssessmentContext = { text: string; tools: string[] };

const CONTEXT_TOOLS = ["container.inspect", "container.logs"] as const;
const LOG_TAIL = 60;
const RESULT_LIMIT = 3_000;

/**
 * Read-only context for the Assessment, gathered by Core before the model is asked: the container's
 * inspect output and a log tail, through the same tool layer a chat uses, so secrets are redacted and
 * output is bounded and fenced as untrusted. Only these two read tools are ever called; the model is
 * given the text, never the tools. A tool that fails is left out.
 */
export async function gatherContainerContext(
  trigger: Trigger,
  deps: {
    baseTools: () => CustomToolDefinition[];
    audit?: ReturnType<typeof createAuditLog>;
    policy: ReturnType<typeof createPolicyEngine>;
  }
): Promise<AssessmentContext> {
  if (trigger.thread.kind !== "container") return { text: "", tools: [] };
  deps.policy.beginRun();
  const tools = wrapCustomTools(
    deps
      .baseTools()
      .filter((tool) =>
        (CONTEXT_TOOLS as readonly string[]).includes(tool.name)
      ),
    {
      policy: deps.policy,
      audit: deps.audit,
      modelResultLimit: RESULT_LIMIT,
    }
  );
  const used: string[] = [];
  const parts: string[] = [];
  for (const name of CONTEXT_TOOLS) {
    const tool = tools.find((item) => item.name === name);
    if (!tool) continue;
    try {
      const result = await tool.execute("eval", {
        id: trigger.thread.id,
        ...(name === "container.logs" ? { tail: LOG_TAIL } : {}),
      });
      if (result.isError) continue;
      used.push(name);
      parts.push(`${name}:\n${result.content.map((b) => b.text).join("\n")}`);
    } catch {
      // Context is help, not a condition.
    }
  }
  return { text: parts.join("\n\n"), tools: used };
}
