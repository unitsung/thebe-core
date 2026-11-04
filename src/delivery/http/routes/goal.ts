import { toProductGoal, toProductGoalEvent } from "../../../agent/index.ts";
import type { GoalRun } from "../../../agent/types.ts";
import { goalTicketKey } from "../../../agent/tickets/types.ts";
import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { agentError } from "../parsing/errors.ts";
import { parseLogCursor } from "../parsing/query.ts";
import { goalEventStream } from "../protocol/sse.ts";

type Agent = NonNullable<ThebeHttpContext["agent"]>;

const MAX_TRIGGER_ID = 200;

/**
 * Product Goal HTTP. Identity is the parent `thebeSessionId` (no new Goal id). `/v1/goals/{id}` also
 * accepts the id of the ticket that wraps the goal, and every response carries `ticketId` when one does.
 * Canonical session-scoped routes and `/v1/goals` aliases share the same mapper.
 */
export async function handleGoalRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const parsed = parseGoalPath(context.path, context.parts);
  if (!parsed) return undefined;
  if (!context.agent) return agentUnavailable();

  const { request, agent } = context;
  try {
    if (parsed.kind === "collection") {
      if (request.method === "GET") {
        const goals = await agent.listGoals();
        const tickets = await agent.ticketIndex();
        return json({
          goals: goals.map((run) =>
            toProductGoal(
              run,
              tickets.get(goalTicketKey(run.thebeSessionId, run.createdAt))
            )
          ),
        });
      }
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        return createGoal(request, agent);
      }
      return undefined;
    }
    if (!parsed.sessionId) {
      return json({ ok: false, error: "goal not found" }, 404);
    }
    // `/v1/goals/{id}` also takes a ticket id; the session routes take only a session id.
    const sessionId =
      context.parts[1] === "goals"
        ? await agent.resolveGoalId(parsed.sessionId)
        : parsed.sessionId;
    if (parsed.kind === "item") {
      if (request.method === "GET") return getGoal(agent, sessionId);
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        return createGoal(request, agent, sessionId);
      }
      return undefined;
    }
    if (parsed.kind === "log") {
      if (request.method !== "GET") return undefined;
      return goalLog(context, agent, sessionId);
    }
    if (parsed.kind === "answer") {
      if (request.method !== "POST") return undefined;
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      return answerGoal(request, agent, sessionId);
    }
    if (
      parsed.kind === "pause" ||
      parsed.kind === "resume" ||
      parsed.kind === "stop"
    ) {
      if (request.method !== "POST") return undefined;
      if (parsed.kind === "resume") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
      }
      return controlGoal(agent, sessionId, parsed.kind);
    }
    return undefined;
  } catch (error) {
    return mapGoalError(error);
  }
}

async function createGoal(
  request: Request,
  agent: Agent,
  existingSessionId?: string
): Promise<Response> {
  const body = await readJson(request);
  const goalText =
    (typeof body.goal === "string" && body.goal.trim()) ||
    (typeof body.title === "string" && body.title.trim()) ||
    "";
  if (!goalText) {
    return json(
      { ok: false, error: "goal cannot be empty", code: "invalid_body" },
      400
    );
  }
  const rawTriggerId = body.triggerId;
  if (
    rawTriggerId !== undefined &&
    (typeof rawTriggerId !== "string" ||
      !rawTriggerId.trim() ||
      rawTriggerId.length > MAX_TRIGGER_ID)
  ) {
    return json(
      {
        ok: false,
        error: `triggerId must be a non-empty string of at most ${MAX_TRIGGER_ID} characters`,
        code: "invalid_body",
      },
      400
    );
  }
  const triggerId =
    typeof rawTriggerId === "string" ? rawTriggerId.trim() : undefined;
  // The same trigger asked twice is the same goal: answer with it and start nothing.
  const started = triggerId ? await agent.goalForTrigger(triggerId) : undefined;
  if (started) return goalResponse(agent, started, 200);
  const criteria = asStringList(body.criteria);
  const maxIterations =
    typeof body.maxIterations === "number" ? body.maxIterations : undefined;
  const model =
    body.model && typeof body.model === "object"
      ? (body.model as Record<string, unknown>)
      : undefined;
  const providerId =
    typeof model?.providerId === "string" ? model.providerId : "";
  const modelId = typeof model?.modelId === "string" ? model.modelId : "";
  if (body.model !== undefined && (!providerId || !modelId)) {
    return json(
      {
        ok: false,
        error: "model.providerId and model.modelId required",
        code: "invalid_body",
      },
      400
    );
  }
  // The workers and reviewer inherit the parent session's model, so choosing it here chooses it for the Goal.
  const thebeSessionId =
    existingSessionId ??
    (
      await agent.createSession({
        title: goalText.slice(0, 80),
        labels: { kind: "goal" },
        model: providerId && modelId ? { providerId, modelId } : undefined,
      })
    ).thebeSessionId;
  const current = agent.getGoal(thebeSessionId);
  if (current?.status === "running" || current?.status === "pausing") {
    return json(
      {
        ok: false,
        error: "a goal is already running for this session",
        code: "invalid_transition",
      },
      409
    );
  }
  if (current?.status === "paused") {
    return json(
      {
        ok: false,
        error: "goal is paused; resume it instead of starting a new one",
        code: "invalid_transition",
      },
      409
    );
  }
  const run = await agent.startGoal({
    thebeSessionId,
    goal: goalText,
    criteria,
    maxIterations,
    triggerId,
  });
  return goalResponse(agent, run, existingSessionId ? 200 : 201);
}

async function goalResponse(
  agent: Agent,
  run: GoalRun,
  status = 200
): Promise<Response> {
  const tickets = await agent.ticketIndex();
  return json(
    toProductGoal(
      run,
      tickets.get(goalTicketKey(run.thebeSessionId, run.createdAt))
    ),
    status
  );
}

async function loadGoal(agent: Agent, sessionId: string) {
  const live = agent.getGoal(sessionId);
  if (live) return live;
  const listed = await agent.listGoals();
  return listed.find((run) => run.thebeSessionId === sessionId);
}

async function getGoal(agent: Agent, sessionId: string): Promise<Response> {
  const run = await loadGoal(agent, sessionId);
  if (run) return goalResponse(agent, run);
  return json({ ok: false, error: "goal not found" }, 404);
}

async function goalLog(
  context: ThebeHttpContext,
  agent: Agent,
  sessionId: string
): Promise<Response> {
  if (!(await loadGoal(agent, sessionId))) {
    return json({ ok: false, error: "goal not found" }, 404);
  }
  const afterResult = parseLogCursor(context.request, context.url);
  if (!afterResult.ok) {
    return json({ error: afterResult.error }, 400);
  }
  const follow =
    context.url.searchParams.get("follow") === "true" ||
    (context.request.headers.get("accept") ?? "").includes("text/event-stream");
  if (follow) {
    return goalEventStream(
      agent,
      sessionId,
      context.request,
      afterResult.after
    );
  }
  const events = agent.goalEvents(sessionId).slice(afterResult.after);
  return json({
    events: events.map((row, index) =>
      toProductGoalEvent(
        sessionId,
        row.event,
        afterResult.after + index,
        row.at
      )
    ),
    next: agent.goalEvents(sessionId).length,
  });
}

async function answerGoal(
  request: Request,
  agent: Agent,
  sessionId: string
): Promise<Response> {
  const body = await readJson(request);
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!answer) {
    return json(
      { ok: false, error: "answer cannot be empty", code: "invalid_body" },
      400
    );
  }
  const current = await loadGoal(agent, sessionId);
  if (!current) return json({ ok: false, error: "goal not found" }, 404);
  // loadGoal also restores a goal that is only persisted, so a question survives a restart.
  if (!current.attention) {
    return json(
      {
        ok: false,
        error: "no question is open for this goal",
        code: "invalid_transition",
      },
      409
    );
  }
  return goalResponse(agent, await agent.answerGoal(sessionId, answer));
}

async function controlGoal(
  agent: Agent,
  sessionId: string,
  action: "pause" | "resume" | "stop"
): Promise<Response> {
  const current = await loadGoal(agent, sessionId);
  if (!current) {
    return json({ ok: false, error: "goal not found" }, 404);
  }
  if (action === "pause" && current.status !== "running") {
    return json(
      {
        ok: false,
        error: "goal can only be paused while running",
        code: "invalid_transition",
      },
      409
    );
  }
  if (action === "resume" && current.status !== "paused") {
    return json(
      {
        ok: false,
        error: "goal can only be resumed while paused",
        code: "invalid_transition",
      },
      409
    );
  }
  if (
    action === "stop" &&
    current.status !== "running" &&
    current.status !== "pausing" &&
    current.status !== "paused"
  ) {
    return json(
      {
        ok: false,
        error: "goal is already finished",
        code: "invalid_transition",
      },
      409
    );
  }
  const run =
    action === "pause"
      ? await agent.pauseGoal(sessionId)
      : action === "resume"
        ? await agent.resumeGoal(sessionId)
        : await agent.stopGoal(sessionId);
  return goalResponse(agent, run);
}

function parseGoalPath(
  path: string,
  parts: string[]
):
  | { kind: "collection"; sessionId?: undefined }
  | {
      kind: "item" | "log" | "pause" | "resume" | "stop" | "answer";
      sessionId: string;
    }
  | undefined {
  if (parts[0] !== "v1") return undefined;
  if (parts[1] === "goals") {
    if (parts.length === 2) {
      return { kind: "collection" };
    }
    const id = parts[2] ?? "";
    if (!id) return undefined;
    if (parts.length === 3) return { kind: "item", sessionId: id };
    if (parts.length === 4 && parts[3] === "log")
      return { kind: "log", sessionId: id };
    if (
      parts.length === 4 &&
      (parts[3] === "pause" ||
        parts[3] === "resume" ||
        parts[3] === "stop" ||
        parts[3] === "answer")
    ) {
      return { kind: parts[3], sessionId: id };
    }
    return undefined;
  }
  if (parts[1] === "session" && parts[3] === "goal") {
    const id = parts[2] ?? "";
    if (!id) return undefined;
    if (parts.length === 4) return { kind: "item", sessionId: id };
    if (parts.length === 5 && parts[4] === "log")
      return { kind: "log", sessionId: id };
    if (
      parts.length === 5 &&
      (parts[4] === "pause" ||
        parts[4] === "resume" ||
        parts[4] === "stop" ||
        parts[4] === "answer")
    ) {
      return { kind: parts[4], sessionId: id };
    }
    return undefined;
  }
  return undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string" && Boolean(item.trim())
  );
  return items.length > 0 ? items : undefined;
}

function mapGoalError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/cannot be empty/i.test(message)) {
    return json({ ok: false, error: message, code: "invalid_body" }, 400);
  }
  if (/already running|goal is paused/i.test(message)) {
    return json({ ok: false, error: message, code: "invalid_transition" }, 409);
  }
  if (/no question is open|not waiting for an answer/i.test(message)) {
    return json({ ok: false, error: message, code: "invalid_transition" }, 409);
  }
  if (/answer cannot be empty/i.test(message)) {
    return json({ ok: false, error: message, code: "invalid_body" }, 400);
  }
  if (/no goal found/i.test(message)) {
    return json({ ok: false, error: "goal not found" }, 404);
  }
  return agentError(error);
}
