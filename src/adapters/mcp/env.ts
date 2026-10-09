const SAFE_KEYS = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "TMPDIR"] as const;

/**
 * The environment a stdio MCP server starts with: a few basics plus its own `env`. Core's process
 * environment holds provider keys and service tokens, so it is never inherited.
 */
export function mcpServerEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}
