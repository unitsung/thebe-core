/** Authenticated service boundary. Credentials and transport stay in adapters. */
export interface ServiceAPIProvider {
  id: string;
  catalog(input?: { query?: string; operationId?: string; offset?: number; limit?: number; refresh?: boolean; signal?: AbortSignal }): unknown | Promise<unknown>;
  request(input: { method: string; path: string; body?: unknown; contentType?: string; readOnly: boolean; signal?: AbortSignal }): Promise<unknown>;
}

export const SERVICE_API_TOOL_NAMES = ["service_api_discover", "service_api_read", "service_api_write"] as const;
export const SERVICE_API_WRITE_TOOL_NAME = "service_api_write";
