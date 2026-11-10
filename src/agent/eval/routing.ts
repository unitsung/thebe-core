import type { McpCaller } from "../interface.ts";
import type { TriggerStore } from "../sources/store.ts";
import type { TicketStore } from "../tickets/store.ts";
import { httpError } from "../types.ts";
import type { EvalDispositionStore } from "./disposition-store.ts";
import type { EvalService } from "./service.ts";
import {
  THREAD_UNSUBSCRIBE_TOOL_NAME,
  TRIGGER_REQUEUE_TOOL_NAME,
  type EvalRoutingToolName,
} from "./routing-tools.ts";

export type EvalRoutingApi = ReturnType<typeof createEvalRoutingApi>;

export function createEvalRoutingApi(options: {
  triggers: Pick<TriggerStore, "get">;
  tickets: Pick<TicketStore, "list" | "unsubscribeThread">;
  dispositions: Pick<EvalDispositionStore, "requeueTrigger">;
  eval: Pick<EvalService, "requeue">;
  checkWritable: () => void;
  now: () => Date;
}) {
  async function requeueTrigger(
    triggerId: string,
    requester: string
  ): Promise<{
    queued: true;
    triggerId: string;
    requeueId: string;
  }> {
    options.checkWritable();
    const id = triggerId.trim();
    if (!id) {
      throw httpError(400, "triggerId is required", "invalid_body");
    }
    const trigger = await options.triggers.get(id);
    if (!trigger) {
      throw httpError(404, "trigger not found", "not_found");
    }
    const owners = (await options.tickets.list()).filter((ticket) =>
      ticket.inputs.some((input) => input.triggerId === trigger.id)
    );
    if (owners.length > 0) {
      throw httpError(
        409,
        `this follow-up already belongs to Ticket ${owners[0]!.id}; ask that worker to hand it back first`,
        "trigger_owned_by_ticket"
      );
    }
    const disposition = await options.dispositions.requeueTrigger({
      triggerId: trigger.id,
      at: options.now().toISOString(),
      requester,
    });
    options.eval.requeue(trigger, disposition.id);
    return {
      queued: true,
      triggerId: trigger.id,
      requeueId: disposition.id,
    };
  }

  async function unsubscribeThread(thread: string): Promise<{
    thread: string;
    removedFrom: string[];
  }> {
    options.checkWritable();
    const key = thread.trim();
    if (!key) {
      throw httpError(400, "thread is required", "invalid_body");
    }
    return {
      thread: key,
      removedFrom: await options.tickets.unsubscribeThread(key),
    };
  }

  async function invoke(
    name: EvalRoutingToolName,
    input: Record<string, unknown>,
    caller: McpCaller
  ): Promise<unknown> {
    if (!caller.writes) {
      throw httpError(
        403,
        `${name} needs write permission`,
        "mcp_write_required"
      );
    }
    switch (name) {
      case TRIGGER_REQUEUE_TOOL_NAME:
        return requeueTrigger(
          typeof input.triggerId === "string" ? input.triggerId : "",
          caller.name === "main-session"
            ? "chat"
            : caller.name?.trim()
              ? `mcp:${caller.name.trim()}`
              : "mcp:anonymous"
        );
      case THREAD_UNSUBSCRIBE_TOOL_NAME:
        return unsubscribeThread(
          typeof input.thread === "string" ? input.thread : ""
        );
    }
  }

  return {
    requeueTrigger,
    unsubscribeThread,
    invoke,
  };
}
