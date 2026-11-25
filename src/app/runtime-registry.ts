export const AGENT_RUNTIME_NAMES = ["dsh", "pi"] as const;
export type AgentRuntimeName = (typeof AGENT_RUNTIME_NAMES)[number];
type RuntimeModelRef = { providerId: string; modelId: string };

export type RuntimeBootstrapSelection = {
  model?: RuntimeModelRef;
  primaryApiKey?: { providerId: "openai" | "anthropic"; key: string };
};

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

/**
 * Pi keeps its legacy environment-based provider defaults. DSH owns its own
 * provider selection so unrelated OpenAI or Anthropic credentials cannot
 * accidentally select an incompatible model for the default runtime.
 */
export function selectRuntimeBootstrap(
  runtimeName: AgentRuntimeName,
  requestedModel: RuntimeModelRef | undefined,
  env: NodeJS.ProcessEnv
): RuntimeBootstrapSelection {
  let model = requestedModel;
  let primaryApiKey: RuntimeBootstrapSelection["primaryApiKey"];
  if (runtimeName !== "pi") return model ? { model } : {};

  const openaiKey = env.OPENAI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (openaiKey) {
    model ??= { providerId: "openai", modelId: "gpt-4o" };
    primaryApiKey = { providerId: "openai", key: openaiKey };
  } else if (anthropicKey) {
    model ??= { providerId: "anthropic", modelId: "claude-sonnet-4" };
    primaryApiKey = { providerId: "anthropic", key: anthropicKey };
  }
  return {
    ...(model ? { model } : {}),
    ...(primaryApiKey ? { primaryApiKey } : {}),
  };
}
