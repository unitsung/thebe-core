/** Authenticated service boundary. Credentials and transport stay in adapters. */
export interface ServiceAPIProvider {
  id: string;
  catalog(input?: {
    query?: string;
    operationId?: string;
    offset?: number;
    limit?: number;
    refresh?: boolean;
    signal?: AbortSignal;
  }): unknown | Promise<unknown>;
  request(input: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string;
    readOnly: boolean;
    signal?: AbortSignal;
  }): Promise<unknown>;
  /**
   * The operations this service documents, for per-operation tool exposure. Only
   * operations the operator allow-listed as read-only become callable tools; the
   * rest stay behind `service_api_discover` / `service_api_write`.
   */
  operations?(): Promise<ServiceAPIOperation[]> | ServiceAPIOperation[];
}

export const SERVICE_API_TOOL_NAMES = [
  "service_api_discover",
  "service_api_read",
  "service_api_write",
] as const;
export const SERVICE_API_WRITE_TOOL_NAME = "service_api_write";

/**
 * Product/MCP-only capability that executes a previewed write. Not a model tool:
 * the model's approved write path stays `service_api_write`.
 */
export const SERVICE_API_CONFIRM_TOOL_NAME = "service_api.confirm";

/** Id prefix for one tool per allow-listed read operation of a configured service. */
export const SERVICE_API_OPERATION_PREFIX = "service_api.";

export type ServiceAPIParameterLocation = "path" | "query" | "header";

export type ServiceAPIParameter = {
  name: string;
  in: ServiceAPIParameterLocation;
  required: boolean;
  schema?: Record<string, unknown>;
  description?: string;
};

export type ServiceAPIOperation = {
  /** Stable operation id from the document, or `METHOD path` when it has none. */
  id: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  /** Operator allow-listed as read-only. Only these are exposed and invokable. */
  readOnly: boolean;
  /** Operator allow-listed for a preview + confirm write tool. */
  writable: boolean;
  parameters: ServiceAPIParameter[];
  requestBody?: {
    required: boolean;
    contentType?: string;
    schema?: Record<string, unknown>;
  };
};

function segment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "operation";
}

/** The tool id for one operation, e.g. `service_api.petstore.findPetsByStatus`. */
export function serviceOperationToolName(
  serviceId: string,
  operationId: string
): string {
  return `${SERVICE_API_OPERATION_PREFIX}${segment(serviceId)}.${segment(operationId)}`;
}

/** Whether an operation can be exposed as a standalone read tool at all. */
export function serviceOperationExposable(
  operation: ServiceAPIOperation
): boolean {
  if (!operation.readOnly) return false;
  // A required header parameter cannot be supplied generically (headers are
  // operator-owned), so such an operation stays behind service_api_write.
  return !operation.parameters.some(
    (parameter) => parameter.in === "header" && parameter.required
  );
}

/** Whether an operation can be exposed as a preview + confirm write tool. */
export function serviceOperationWritable(
  operation: ServiceAPIOperation
): boolean {
  if (operation.readOnly || !operation.writable) return false;
  return !operation.parameters.some(
    (parameter) => parameter.in === "header" && parameter.required
  );
}

/** The tool schema for one operation: parameters by name, plus an optional body. */
export function serviceOperationInputSchema(
  operation: ServiceAPIOperation
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in === "header") continue;
    properties[parameter.name] = {
      ...(parameter.schema ?? { type: "string" }),
      ...(parameter.description ? { description: parameter.description } : {}),
    };
    if (parameter.required) required.push(parameter.name);
  }
  if (operation.requestBody) {
    properties.body = operation.requestBody.schema ?? {
      type: "object",
      additionalProperties: true,
    };
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Build a concrete request from tool arguments. Pure; the adapter still enforces safety. */
export function serviceOperationRequest(
  operation: ServiceAPIOperation,
  args: Record<string, unknown>
): { method: string; path: string; body?: unknown; readOnly: boolean } {
  let path = operation.path;
  for (const parameter of operation.parameters) {
    if (parameter.in !== "path") continue;
    const value = args[parameter.name];
    if (value === undefined || value === null || value === "") {
      if (parameter.required)
        throw new Error(`missing required path parameter: ${parameter.name}`);
      continue;
    }
    path = path.replaceAll(
      `{${parameter.name}}`,
      encodeURIComponent(String(value))
    );
  }
  if (/\{[^}]+\}/.test(path))
    throw new Error("a required path parameter was not supplied");
  const query = new URLSearchParams();
  for (const parameter of operation.parameters) {
    if (parameter.in !== "query") continue;
    const value = args[parameter.name];
    if (value === undefined || value === null || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value])
      query.append(parameter.name, String(item));
  }
  const suffix = query.toString();
  const body = operation.requestBody ? args.body : undefined;
  return {
    method: operation.method,
    path: suffix ? `${path}?${suffix}` : path,
    ...(body === undefined ? {} : { body }),
    readOnly: operation.readOnly,
  };
}
