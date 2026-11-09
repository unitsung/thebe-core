export const TICKET_LIST_TOOL_NAME = "ticket_list" as const;
export const TICKET_GET_TOOL_NAME = "ticket_get" as const;
export const TICKET_DELEGATE_TOOL_NAME = "ticket_delegate" as const;
export const TICKET_REPLY_TOOL_NAME = "ticket_reply" as const;

export const TICKET_TOOL_NAMES = [
  TICKET_LIST_TOOL_NAME,
  TICKET_GET_TOOL_NAME,
  TICKET_DELEGATE_TOOL_NAME,
  TICKET_REPLY_TOOL_NAME,
] as const;

export type TicketToolName = (typeof TICKET_TOOL_NAMES)[number];

export const TICKET_TOOL_WRITE_NAMES: ReadonlySet<string> = new Set([
  TICKET_DELEGATE_TOOL_NAME,
  TICKET_REPLY_TOOL_NAME,
]);

export const TICKET_TOOL_SCHEMAS: Record<
  TicketToolName,
  Record<string, unknown>
> = {
  [TICKET_LIST_TOOL_NAME]: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 20,
        description: "Newest Tickets to return.",
      },
    },
    additionalProperties: false,
  },
  [TICKET_GET_TOOL_NAME]: {
    type: "object",
    properties: {
      ticketId: {
        type: "string",
        pattern: "^[a-f0-9]{32}$",
        description:
          "The Ticket id returned by ticket_delegate or ticket_list.",
      },
    },
    required: ["ticketId"],
    additionalProperties: false,
  },
  [TICKET_DELEGATE_TOOL_NAME]: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "The complete long-running objective. The worker does not inherit this caller's conversation.",
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description:
          "Stable caller-generated key. Retrying with the same key returns the existing Ticket.",
      },
      criteria: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: "Observable conditions an independent reviewer checks.",
      },
      maxIterations: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum worker checkpoints; defaults to 8.",
      },
      observe: {
        type: "boolean",
        description: "When true, inspect and report without changing anything.",
      },
      allowAsk: {
        type: "boolean",
        default: true,
        description:
          "Let the worker pause with a question answerable through ticket_reply.",
      },
      reviewBeforeDone: {
        type: "boolean",
        description:
          "After independent review passes, wait for ticket_reply before completing.",
      },
    },
    required: ["task", "idempotencyKey"],
    additionalProperties: false,
  },
  [TICKET_REPLY_TOOL_NAME]: {
    type: "object",
    properties: {
      ticketId: {
        type: "string",
        pattern: "^[a-f0-9]{32}$",
      },
      attentionId: {
        type: "string",
        description:
          "The open attention id from ticket_get. Answer the worker's question or review its result.",
      },
      answer: {
        type: "string",
        maxLength: 4000,
        description:
          "The answer, or feedback when sending a reviewed result back.",
      },
      decision: {
        type: "string",
        enum: ["accept", "reject"],
        description: "Required when the open attention is a review.",
      },
      permissionId: {
        type: "string",
        description:
          "A pending permission id from ticket_get. Decide whether the worker may run that one tool call.",
      },
      permissionDecision: {
        type: "string",
        enum: ["allow", "deny"],
        description: "The decision for permissionId.",
      },
    },
    required: ["ticketId"],
    additionalProperties: false,
  },
};

export const TICKET_TOOL_DESCRIPTIONS: Record<TicketToolName, string> = {
  [TICKET_LIST_TOOL_NAME]:
    "List recent durable Tickets with their current Goal stage.",
  [TICKET_GET_TOOL_NAME]:
    "Read one Ticket with its Goal report, receipt, open attention, and pending permissions.",
  [TICKET_DELEGATE_TOOL_NAME]:
    "Delegate one long-running task to Thebe and return its durable Ticket.",
  [TICKET_REPLY_TOOL_NAME]:
    "Answer a Ticket attention or approve/deny one pending worker permission.",
};
