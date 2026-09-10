export function sanitizeBashEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {};
  const sensitivePatterns = [
    /^THEBE_/i,
    /^DATABASE_/i,
    /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)$/i,
  ];
  for (const [key, val] of Object.entries(env)) {
    if (key.startsWith("PI_")) {
      sanitized[key] = val;
      continue;
    }
    const isSensitive = sensitivePatterns.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      sanitized[key] = val;
    }
  }
  return sanitized;
}
