export const STRM_REPAIR_CAPABILITY_ID = "strm.repair" as const;

export type StrmRepairRequest = {
  arguments: unknown;
  resource?: Record<string, unknown>;
};

export type StrmRepairOutcome = {
  status: "repaired" | "unchanged";
  summary: string;
  target?: string;
  verification?: Record<string, unknown>;
};

/** Provider-owned write boundary for repairing one STRM source. */
export type StrmRepairProvider = {
  service: string;
  repair(input: StrmRepairRequest): Promise<StrmRepairOutcome>;
};

export const STRM_REPAIR_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string", description: "STRM item title" },
    mediaType: { type: "string", description: "Media type" },
    source: { type: "string", description: "Source surface" },
    itemId: { type: "string", description: "Provider item or file id" },
    instanceId: { type: "string", description: "Provider instance id" },
    service: { type: "string", description: "Provider service" },
  },
};

export const STRM_REPAIR_DESCRIPTION =
  "Repair one STRM source through the configured provider and verify the result.";
