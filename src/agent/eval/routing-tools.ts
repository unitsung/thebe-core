export const TRIGGER_REQUEUE_TOOL_NAME = "trigger_requeue" as const;
export const THREAD_UNSUBSCRIBE_TOOL_NAME = "thread_unsubscribe" as const;

export const EVAL_ROUTING_TOOL_NAMES = [
  TRIGGER_REQUEUE_TOOL_NAME,
  THREAD_UNSUBSCRIBE_TOOL_NAME,
] as const;

export type EvalRoutingToolName = (typeof EVAL_ROUTING_TOOL_NAMES)[number];

export const EVAL_ROUTING_TOOL_WRITE_NAMES: ReadonlySet<string> = new Set(
  EVAL_ROUTING_TOOL_NAMES
);

export const EVAL_ROUTING_TOOL_SCHEMAS: Record<
  EvalRoutingToolName,
  Record<string, unknown>
> = {
  [TRIGGER_REQUEUE_TOOL_NAME]: {
    type: "object",
    properties: {
      triggerId: {
        type: "string",
        pattern: "^[a-f0-9]{32}$",
        description:
          "The recorded Trigger to weigh again under the current Policy.",
      },
    },
    required: ["triggerId"],
    additionalProperties: false,
  },
  [THREAD_UNSUBSCRIBE_TOOL_NAME]: {
    type: "object",
    properties: {
      thread: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "The Thread whose subscriptions should be removed, for example resource:container:emby.",
      },
    },
    required: ["thread"],
    additionalProperties: false,
  },
};

export const EVAL_ROUTING_TOOL_DESCRIPTIONS: Record<
  EvalRoutingToolName,
  string
> = {
  [TRIGGER_REQUEUE_TOOL_NAME]:
    "Queue one recorded Trigger for a fresh Assessment under the current Policy. Attached follow-ups are left to their owning Ticket.",
  [THREAD_UNSUBSCRIBE_TOOL_NAME]:
    "Drop every Ticket subscription to one Thread. Existing work and inputs remain; later events on that Thread are weighed independently until a Ticket subscribes again.",
};
