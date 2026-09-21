export const CAPABILITY_INVOKE_MODES = ["direct", "background"] as const;
export type CapabilityInvokeMode = (typeof CAPABILITY_INVOKE_MODES)[number];
export const CAPABILITY_INVOKE_MODE_DIRECT = CAPABILITY_INVOKE_MODES[0];
export const CAPABILITY_INVOKE_MODE_BACKGROUND = CAPABILITY_INVOKE_MODES[1];

export const CAPABILITY_INVOKE_TYPES = ["result", "run"] as const;
export type CapabilityInvokeType = (typeof CAPABILITY_INVOKE_TYPES)[number];
export const CAPABILITY_INVOKE_TYPE_RESULT = CAPABILITY_INVOKE_TYPES[0];
export const CAPABILITY_INVOKE_TYPE_RUN = CAPABILITY_INVOKE_TYPES[1];

export const CAPABILITY_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type CapabilityRunStatus = (typeof CAPABILITY_RUN_STATUSES)[number];
export const CAPABILITY_RUN_STATUS_RUNNING = CAPABILITY_RUN_STATUSES[1];
export const CAPABILITY_RUN_STATUS_SUCCEEDED = CAPABILITY_RUN_STATUSES[2];
export const CAPABILITY_RUN_STATUS_FAILED = CAPABILITY_RUN_STATUSES[3];

export type CapabilityInvokeInput = {
  resource?: Record<string, unknown>;
  arguments?: unknown;
  mode?: CapabilityInvokeMode;
};

export type CapabilityRun = {
  runId: string;
  capabilityId: string;
  status: CapabilityRunStatus;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
  resource?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type CapabilityInvokeResult =
  | { type: typeof CAPABILITY_INVOKE_TYPE_RESULT; result: unknown }
  | { type: typeof CAPABILITY_INVOKE_TYPE_RUN; runId: string };

export function parseCapabilityInvokeMode(value: unknown): CapabilityInvokeMode | undefined {
  for (const mode of CAPABILITY_INVOKE_MODES) {
    if (value === mode) return mode;
  }
  return undefined;
}

export function parseCapabilityResult(text: string): unknown {
  const unwrapped = unwrapToolOutput(text);
  try {
    return JSON.parse(unwrapped) as unknown;
  } catch {
    return unwrapped;
  }
}

function unwrapToolOutput(text: string): string {
  const match = text.match(/<tool_output\b[^>]*>\s*([\s\S]*?)\s*<\/tool_output>/i);
  return (match?.[1] ?? text).trim();
}
