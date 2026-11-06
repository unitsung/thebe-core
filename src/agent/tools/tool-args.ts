/** Reading a tool call's arguments and shaping its result: the same few rules for every tool. */

export type TextToolResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
};

export function textResult(result: unknown): TextToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    details: {},
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

export function integerOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}
