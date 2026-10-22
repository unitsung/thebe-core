/** What a model provider's failed reply means for a caller, read from the runtime's raw error text. */
export type ProviderFailure = {
  /** HTTP status Core answers with: 502 for an upstream fault, 429 when the provider is rate limiting. */
  status: 429 | 502;
  code: "provider_auth_failed" | "provider_rate_limited" | "provider_error";
  /** One readable sentence; the provider's own wording is kept, its JSON envelope is not. */
  message: string;
};

/** Runtimes surface a provider failure as `<status> <body>`; anything else is not a provider failure. */
export function describeProviderFailure(
  raw: string
): ProviderFailure | undefined {
  const match = /^(\d{3})(?:\s+([\s\S]*))?$/.exec(raw.trim());
  if (!match) return undefined;
  const upstream = Number(match[1]);
  if (upstream < 400 || upstream > 599) return undefined;
  const detail = providerMessage(match[2] ?? "") || `HTTP ${upstream}`;
  if (upstream === 401 || upstream === 403) {
    return {
      status: 502,
      code: "provider_auth_failed",
      message: `The model provider rejected Core's credentials (${upstream}): ${detail}`,
    };
  }
  if (upstream === 429) {
    return {
      status: 429,
      code: "provider_rate_limited",
      message: `The model provider is rate limiting requests: ${detail}`,
    };
  }
  return {
    status: 502,
    code: "provider_error",
    message: `The model provider failed (${upstream}): ${detail}`,
  };
}

function providerMessage(body: string): string {
  const text = body.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    const found = findMessage(parsed);
    if (found) return found;
  } catch {
    // Not JSON: the text is the provider's own wording.
  }
  return text.slice(0, 500);
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const found = findMessage(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}
