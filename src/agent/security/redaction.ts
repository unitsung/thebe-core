export const REDACTED = "***REDACTED***";
export const DEFAULT_LOG_TAIL = 200;
export const TRUNCATION_MARKER = "[... truncated ...]";
const HIGH_RISK_TOOL_NAMES = new Set([
  "bash",
  "service_api_write",
  "navidrome.playlist.delete",
]);

const SENSITIVE_ENV_KEY =
  /(SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL|PRIVATE)/i;

const LOG_SECRET_PATTERNS: readonly RegExp[] = [
  /(\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+)[^\s"',}]+/gi,
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
  const safeTail = Number.isFinite(tail)
    ? Math.min(DEFAULT_LOG_TAIL, Math.max(1, Math.trunc(tail)))
    : DEFAULT_LOG_TAIL;
  const truncated = truncateLogLines(text, safeTail);
  return redactSecrets(truncated);
}

export function redactToolOutput(text: string): string {
  const envStyle = text.replace(
    /(SECRET|TOKEN|KEY|PASSWORD|PASS|CREDENTIAL|PRIVATE)("?\s*[:=]\s*"?)([^"\s,}]+)/gi,
    `$1$2${REDACTED}`,
  );
  return redactSecrets(envStyle);
}

/** Static risk hint for the approval UI. */
export function permissionRisk(toolName: string): "high" | "standard" {
  return HIGH_RISK_TOOL_NAMES.has(toolName) ? "high" : "standard";
}

/** Redacted, truncated rendering of a tool input for approval display. */
export function summarizeArgs(args: unknown, maxChars = 500): string {
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else {
    try {
      text = JSON.stringify(args) ?? "";
    } catch {
      text = "";
    }
  }
  const redacted = redactToolOutput(text);
  return redacted.length > maxChars
    ? `${redacted.slice(0, maxChars)}${TRUNCATION_MARKER}`
    : redacted;
}

function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of LOG_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (...match: unknown[]) => typeof match[1] === "string" ? `${match[1]}${REDACTED}` : REDACTED);
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
