import type { ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { parseLimit, parseLogCursor } from "../parsing/query.ts";
import { sessionLogStream } from "../protocol/sse.ts";

/** Session listing, inspection, transcript, event, and export queries. */
export async function handleSessionRead(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  const { request, url, parts, agent } = context;
  if (!agent || parts[0] !== "v1" || parts[1] !== "session") {
    return undefined;
  }
  const method = request.method;
  const id = parts[2];
  const action = parts[3];
  const extra = parts[4];

  if (method === "GET" && parts.length === 2) {
    return json({
      sessions: await agent.listSessions({
        status: url.searchParams.get("status") ?? undefined,
        hostId: url.searchParams.get("hostId") ?? undefined,
        environmentId: url.searchParams.get("environmentId") ?? undefined,
      }),
    });
  }
  if (method === "GET" && id === "status" && parts.length === 3) {
    return json({ sessions: await agent.sessionStatus() });
  }
  if (!id) {
    return undefined;
  }
  if (method === "GET" && parts.length === 3) {
    return json(await agent.getSession(id));
  }
  if (method === "GET" && action === "message" && !extra) {
    return readMessages(agent, id, url);
  }
  if (method === "GET" && action === "message" && extra) {
    const message = await agent.message(id, extra);
    return message ? json(message) : json({ error: "message not found" }, 404);
  }
  if (method === "GET" && action === "log") {
    const afterResult = parseLogCursor(request, url);
    if (!afterResult.ok) {
      return json({ error: afterResult.error }, 400);
    }
    if (url.searchParams.get("follow") === "true") {
      return sessionLogStream(agent, id, request, afterResult.after);
    }
    const events = agent.events(id);
    return json({ events: events.slice(afterResult.after), next: events.length });
  }
  if (method === "GET" && action === "context") {
    return json(await agent.getContext(id));
  }
  if (method === "GET" && action === "background-task" && !extra) {
    return notImplemented("background-task tracking is not implemented");
  }
  if (method === "GET" && action === "children") {
    return json({ sessions: await agent.children(id) });
  }
  if (method === "GET" && action === "export") {
    return exportSession(agent, id, url.searchParams.get("format"));
  }
  if (method === "GET" && action === "diff") {
    return notImplemented("session diff is not implemented");
  }
  if (
    method === "POST" &&
    action === "background-task" &&
    (parts[5] === "stop" || extra === "stop-all")
  ) {
    return notImplemented("background-task tracking is not implemented");
  }
  return undefined;
}

async function readMessages(
  agent: NonNullable<ThebeHttpContext["agent"]>,
  id: string,
  url: URL,
): Promise<Response> {
  const messages = await agent.loadMessages(id);
  const limitResult = parseLimit(url.searchParams.get("limit"));
  if (!limitResult.ok) {
    return json({ error: limitResult.error }, 400);
  }
  const before = url.searchParams.get("before");
  if (before !== null) {
    const found = messages.findIndex((message) => message.id === before);
    if (found < 0) {
      return json({ error: "unknown message cursor" }, 400);
    }
    const start = Math.max(0, found - limitResult.limit);
    return json({
      messages: messages.slice(start, found),
      total: messages.length,
      hasMore: start > 0,
    });
  }
  const after = url.searchParams.get("after");
  let start = 0;
  if (after !== null) {
    const found = messages.findIndex((message) => message.id === after);
    if (found < 0) {
      return json({ error: "unknown message cursor" }, 400);
    }
    start = found + 1;
  }
  const sliced = messages.slice(start, start + limitResult.limit);
  return json({
    messages: sliced,
    total: messages.length,
    hasMore: start + sliced.length < messages.length,
  });
}

async function exportSession(
  agent: NonNullable<ThebeHttpContext["agent"]>,
  id: string,
  format: string | null,
): Promise<Response> {
  const exported = await agent.exportSession(id);
  if (format === "jsonl") {
    return new Response(exported.jsonl, {
      headers: {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="session-${id}.jsonl"`,
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (format === "html") {
    return new Response(exported.html, {
      headers: {
        "content-type": "text/html",
        "content-disposition": `attachment; filename="session-${id}.html"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  }
  if (format !== null) {
    return json({ error: "invalid format; want jsonl or html" }, 400);
  }
  return json(exported);
}

function notImplemented(message: string): Response {
  return json(
    { ok: false, code: "feature_not_implemented", error: message },
    501,
  );
}
