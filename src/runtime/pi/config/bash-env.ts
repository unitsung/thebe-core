export function sanitizeBashEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  const sensitivePatterns = [
    /^THEBE_/i,
    /^DATABASE_/i,
    /^ARCANE_/i,
    /^(AWS_|OPENAI_|ANTHROPIC_|OPENCODE_)/i,
    /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)/i,
  ];
  for (const [key, val] of Object.entries(env)) {
    const isSensitive = sensitivePatterns.some((pattern) => pattern.test(key));
    if (isSensitive) {
      continue;
    }
    sanitized[key] = val;
  }
  return sanitized;
}
