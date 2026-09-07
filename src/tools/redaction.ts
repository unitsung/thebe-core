export const REDACTED = "***REDACTED***";
export const DEFAULT_LOG_TAIL = 200;
export const TRUNCATION_MARKER = "[... truncated ...]";

const SENSITIVE_ENV_KEY =
  /(SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL|PRIVATE)/i;

const LOG_SECRET_PATTERNS: readonly RegExp[] = [
  /\b[0-9a-f]{40}\b/gi,
  /\bsk-[A-Za-z0-9_-]+\b/g,
];

export function redactEnv(entries: string[]): string[] {
  return entries.map(redactEnvLine);
}

function redactEnvLine(line: string): string {
  const eq = line.indexOf("=");
  if (eq <= 0) {
    return line;
  }
  const key = line.slice(0, eq);
  if (SENSITIVE_ENV_KEY.test(key)) {
    return `${key}=${REDACTED}`;
  }
  return line;
}

export function redactLogs(text: string, tail = DEFAULT_LOG_TAIL): string {
  const truncated = truncateLogLines(text, tail);
  return redactSecrets(truncated);
}

export function redactToolOutput(text: string): string {
  const envStyle = text.replace(
    /(SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL|PRIVATE)("?\s*[:=]\s*"?)([^"\s,}]+)/gi,
    `$1$2${REDACTED}`,
  );
  return redactSecrets(envStyle);
}

function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of LOG_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

function truncateLogLines(text: string, tail: number): string {
  const lines = text.split("\n");
  if (lines.length <= tail) {
    return text;
  }
  const kept = lines.slice(-tail);
  return `${TRUNCATION_MARKER}\n${kept.join("\n")}`;
}
