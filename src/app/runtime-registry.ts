export const AGENT_RUNTIME_NAMES = ["dsh", "pi"] as const;
export type AgentRuntimeName = (typeof AGENT_RUNTIME_NAMES)[number];

/**
 * DeepSeek Harness is the product runtime. Pi remains an explicit
 * compatibility option through THEBE_RUNTIME=pi, while unknown names fail at
 * startup instead of silently selecting a different reasoning loop.
 */
export function selectRuntimeName(
  env: NodeJS.ProcessEnv = process.env
): AgentRuntimeName {
  const value = env.THEBE_RUNTIME?.trim().toLowerCase();
  if (!value) return "dsh";
  if ((AGENT_RUNTIME_NAMES as readonly string[]).includes(value)) {
    return value as AgentRuntimeName;
  }
  throw new Error(
    `Unsupported THEBE_RUNTIME "${env.THEBE_RUNTIME}". Use "dsh" or "pi".`
  );
}
