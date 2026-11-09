import type { McpCaller } from "../interface.ts";
import type { ProductPendingPermission } from "../security/pending-permission.ts";
import { toProductGoal, type ProductGoal } from "../goals/product.ts";
import { httpError } from "../types.ts";
import type { GoalRun } from "../types.ts";
import { directTicketId, key } from "./ids.ts";
import type { TicketStore } from "./store.ts";
import {
  TICKET_DELEGATE_TOOL_NAME,
  TICKET_GET_TOOL_NAME,
  TICKET_LIST_TOOL_NAME,
  TICKET_REPLY_TOOL_NAME,
  type TicketToolName,
} from "./tools.ts";
import type { Ticket } from "./types.ts";

const DEFAULT_TICKET_LIST_LIMIT = 20;
const MAX_TICKET_LIST_LIMIT = 50;
const MAX_TASK_CHARS = 16_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;

export type TicketStage =
  | "unassigned"
  | "running"
  | "attention"
  | "paused"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type TicketReceipt = {
  state: TicketStage;
  complete: boolean;
  summary?: string;
  report?: GoalRun["report"];
  attention?: GoalRun["attention"];
  finalReport?: string;
  artifactId?: string;
  error?: string;
};

export type TicketTaskView = {
  ticket: Ticket;
  stage: TicketStage;
  goal?: ProductGoal & { finalReport?: string };
  pendingPermissions: ProductPendingPermission[];
  receipt: TicketReceipt;
};

export type TicketControlApi = ReturnType<typeof createTicketControlApi>;

type GoalPort = {
  startGoal(input: {
    thebeSessionId: string;
    goal: string;
    criteria?: string[];
    maxIterations?: number;
    observe?: boolean;
    allowAsk?: boolean;
    reviewBeforeDone?: boolean;
  }): Promise<GoalRun>;
  getGoal(thebeSessionId: string): GoalRun | undefined;
  listGoals(): Promise<GoalRun[]>;
  answerGoal(
    thebeSessionId: string,
    input: {
      attentionId: string;
      answer?: string;
      decision?: "accept" | "reject";
    }
  ): Promise<GoalRun>;
};

type SessionPort = {
  createSession(input: {
    title?: string;
    labels?: Record<string, string>;
  }): Promise<{ thebeSessionId: string }>;
  listPendingPermissions(): ProductPendingPermission[];
  resolvePendingPermission(
    id: string,
    decision: { response: "allow" | "deny" }
  ): Promise<void>;
};

export function createTicketControlApi(options: {
  store: TicketStore;
  goals: GoalPort;
  sessions: SessionPort;
  now: () => Date;
}) {
  const delegateFlights = new Map<string, Promise<TicketTaskView>>();

  async function goalFor(ticket: Ticket): Promise<GoalRun | undefined> {
    const id = ticket.links.legacyGoalId;
    if (!id) return undefined;
    const live = options.goals.getGoal(id);
    if (live) return live;
    return (await options.goals.listGoals()).find(
      (run) => run.thebeSessionId === id
    );
  }

  function pendingFor(goalId: string): ProductPendingPermission[] {
    return options.sessions
      .listPendingPermissions()
      .filter((permission) => permission.sessionId === goalId);
  }

  function stageOf(
    goal: GoalRun | undefined,
    pending: readonly ProductPendingPermission[]
  ): TicketStage {
    if (!goal) return "unassigned";
    if (goal.attention || pending.length > 0) return "attention";
    switch (goal.status) {
      case "running":
      case "pausing":
        return "running";
      case "paused":
        return "paused";
      case "completed":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "failed":
        return goal.blocked ? "blocked" : "failed";
      case "max_iterations":
        return "failed";
    }
  }

  function view(
    ticket: Ticket,
    goal: GoalRun | undefined,
    pending: ProductPendingPermission[]
  ): TicketTaskView {
    const stage = stageOf(goal, pending);
    const product = goal ? toProductGoal(goal) : undefined;
    return {
      ticket,
      stage,
      ...(product
        ? {
            goal: {
              ...product,
              ...(goal?.finalReport ? { finalReport: goal.finalReport } : {}),
            },
          }
        : {}),
      pendingPermissions: pending,
      receipt: {
        state: stage,
        complete:
          stage === "completed" ||
          stage === "blocked" ||
          stage === "failed" ||
          stage === "cancelled",
        ...(goal?.summary ? { summary: goal.summary } : {}),
        ...(goal?.report ? { report: { ...goal.report } } : {}),
        ...(goal?.attention ? { attention: { ...goal.attention } } : {}),
        ...(goal?.finalReport ? { finalReport: goal.finalReport } : {}),
        ...(goal?.artifactId ? { artifactId: goal.artifactId } : {}),
        ...(goal?.error ? { error: goal.error } : {}),
      },
    };
  }

  async function get(ticketId: string): Promise<TicketTaskView | undefined> {
    const ticket = await options.store.get(ticketId);
    if (!ticket) return undefined;
    const goal = await goalFor(ticket);
    const pending = goal
      ? pendingFor(goal.thebeSessionId)
      : ticket.links.legacyGoalId
        ? pendingFor(ticket.links.legacyGoalId)
        : [];
    return view(ticket, goal, pending);
  }

  async function list(
    input: Record<string, unknown> = {}
  ): Promise<TicketTaskView[]> {
    const requested =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.floor(input.limit)
        : DEFAULT_TICKET_LIST_LIMIT;
    const limit = Math.max(1, Math.min(MAX_TICKET_LIST_LIMIT, requested));
    const tickets = (await options.store.list()).slice(0, limit);
    return Promise.all(tickets.map(async (ticket) => (await get(ticket.id))!));
  }

  async function delegate(
    input: Record<string, unknown>,
    caller: McpCaller
  ): Promise<TicketTaskView & { reused: boolean }> {
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) throw httpError(400, "task cannot be empty", "invalid_body");
    if (task.length > MAX_TASK_CHARS) {
      throw httpError(
        400,
        `task is longer than ${MAX_TASK_CHARS} characters`,
        "invalid_body"
      );
    }
    const idempotencyKey =
      typeof input.idempotencyKey === "string"
        ? input.idempotencyKey.trim()
        : "";
    if (!idempotencyKey) {
      throw httpError(400, "idempotencyKey is required", "invalid_body");
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      throw httpError(
        400,
        `idempotencyKey is longer than ${MAX_IDEMPOTENCY_KEY_CHARS} characters`,
        "invalid_body"
      );
    }
    const criteria = parseCriteria(input.criteria);
    const requester = caller.name?.trim()
      ? `mcp:${caller.name.trim()}`
      : "mcp:anonymous";
    const requestId = key("mcp-ticket-delegate", requester, idempotencyKey);
    const createdAt = options.now().toISOString();
    const ticketId = directTicketId({
      thread: requester,
      triggerId: requestId,
      kind: "mcp-delegate",
      at: createdAt,
      idempotencyKey: requestId,
    });
    const existing = await get(ticketId);
    if (existing) return { ...existing, reused: true };
    const pending = delegateFlights.get(ticketId);
    if (pending) return { ...(await pending), reused: true };

    const flight = (async () => {
      const raced = await get(ticketId);
      if (raced) return raced;
      const session = await options.sessions.createSession({
        title: task.slice(0, 80),
        labels: {
          kind: "goal",
          mcpRequester: requester,
          mcpRequestId: requestId,
        },
      });
      const run = await options.goals.startGoal({
        thebeSessionId: session.thebeSessionId,
        goal: task,
        criteria,
        maxIterations:
          typeof input.maxIterations === "number"
            ? input.maxIterations
            : undefined,
        ...(input.observe === true ? { observe: true } : {}),
        ...(input.allowAsk !== false ? { allowAsk: true } : {}),
        ...(input.reviewBeforeDone === true ? { reviewBeforeDone: true } : {}),
      });
      const ticket = await options.store.recordDirect({
        thread: requester,
        triggerId: requestId,
        kind: "mcp-delegate",
        at: createdAt,
        idempotencyKey: requestId,
        title: task.slice(0, 120),
        requester,
        goalId: run.thebeSessionId,
        sessionIds: [run.thebeSessionId],
      });
      return view(ticket, run, pendingFor(run.thebeSessionId));
    })();
    delegateFlights.set(ticketId, flight);
    try {
      const result = await flight;
      return { ...result, reused: false };
    } finally {
      delegateFlights.delete(ticketId);
    }
  }

  async function reply(
    input: Record<string, unknown>
  ): Promise<TicketTaskView> {
    const ticketId =
      typeof input.ticketId === "string" ? input.ticketId.trim() : "";
    if (!ticketId) {
      throw httpError(400, "ticketId is required", "invalid_body");
    }
    const ticket = await options.store.get(ticketId);
    if (!ticket) throw httpError(404, "ticket not found", "not_found");
    const goalId = ticket.links.legacyGoalId;
    if (!goalId) {
      throw httpError(
        409,
        "ticket has no running assignment",
        "ticket_unassigned"
      );
    }
    const permissionId =
      typeof input.permissionId === "string" ? input.permissionId.trim() : "";
    if (permissionId) {
      const permission = options.sessions
        .listPendingPermissions()
        .find((item) => item.id === permissionId && item.sessionId === goalId);
      if (!permission) {
        throw httpError(
          404,
          "pending permission not found for this ticket",
          "not_found"
        );
      }
      const decision = input.permissionDecision;
      if (decision !== "allow" && decision !== "deny") {
        throw httpError(
          400,
          "permissionDecision must be allow or deny",
          "invalid_body"
        );
      }
      await options.sessions.resolvePendingPermission(permissionId, {
        response: decision,
      });
      return (await get(ticketId))!;
    }

    const attention = (await goalFor(ticket))?.attention;
    if (!attention) {
      throw httpError(
        409,
        "this ticket is not waiting for an answer",
        "attention_none"
      );
    }
    const attentionId =
      typeof input.attentionId === "string" ? input.attentionId.trim() : "";
    if (!attentionId) {
      throw httpError(400, "attentionId is required", "invalid_body");
    }
    await options.goals.answerGoal(goalId, {
      attentionId,
      ...(typeof input.answer === "string" ? { answer: input.answer } : {}),
      ...(input.decision === "accept" || input.decision === "reject"
        ? { decision: input.decision }
        : {}),
    });
    return (await get(ticketId))!;
  }

  async function invoke(
    name: TicketToolName,
    input: Record<string, unknown>,
    caller: McpCaller
  ): Promise<unknown> {
    switch (name) {
      case TICKET_LIST_TOOL_NAME:
        return { tickets: await list(input) };
      case TICKET_GET_TOOL_NAME: {
        const ticketId =
          typeof input.ticketId === "string" ? input.ticketId.trim() : "";
        if (!ticketId) {
          throw httpError(400, "ticketId is required", "invalid_body");
        }
        const ticket = await get(ticketId);
        if (!ticket) {
          throw httpError(404, "ticket not found", "not_found");
        }
        return ticket;
      }
      case TICKET_DELEGATE_TOOL_NAME:
        return delegate(input, caller);
      case TICKET_REPLY_TOOL_NAME:
        return reply(input);
    }
  }

  return {
    invoke,
    get,
    list,
    delegate,
    reply,
  };
}

function parseCriteria(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw httpError(400, "criteria must be an array", "invalid_body");
  }
  if (value.length > 20) {
    throw httpError(400, "criteria accepts at most 20 items", "invalid_body");
  }
  const criteria: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw httpError(
        400,
        "criteria items must be non-empty strings",
        "invalid_body"
      );
    }
    if (item.length > 500) {
      throw httpError(
        400,
        "each criterion is limited to 500 characters",
        "invalid_body"
      );
    }
    criteria.push(item.trim());
  }
  return criteria.length > 0 ? criteria : undefined;
}
