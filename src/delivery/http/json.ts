import { httpError } from "../../agent/types.ts";

export function json(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/**
 * The request body as an object. No body is `{}`; a body that is not JSON is a 400, not an empty
 * request: treating it as `{}` turned a client's malformed approval or patch into a silent no-op.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return asObject(JSON.parse(text));
  } catch {
    throw httpError(400, "Request body must be valid JSON", "invalid_body");
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
}
