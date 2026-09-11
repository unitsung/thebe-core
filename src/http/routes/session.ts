import type { ThebeProduct } from "../../product/service.ts";
import type { ProductSessionMeta } from "../../product/store.ts";
import { asObject, asStringMap, json, readJson } from "../json.ts";
import {
  parseLimit,
  parseLogCursor,
  parseThinkingLevel,
  promptBodyError,
  readPromptBody,
  sessionLogStream,
} from "../parse.ts";

export async function handleSession(
  request: Request,
  url: URL,
  parts: string[],
  product: ThebeProduct,
): Promise<Response> {
  const method = request.method;
  const id = parts[2];
  const action = parts[3];
  const extra = parts[4];

  if (method === "GET" && parts.length === 2) {
    const status = url.searchParams.get("status") ?? undefined;
    const hostId = url.searchParams.get("hostId") ?? undefined;
    const environmentId = url.searchParams.get("environmentId") ?? undefined;
    return json({
      sessions: await product.listSessions({ status, hostId, environmentId }),
    });
  }
  if (method === "POST" && parts.length === 2) {
    const body = await readJson(request);
    const model = asObject(body.model);
    const providerId =
      typeof model.providerId === "string" ? model.providerId : "";
    const modelId = typeof model.modelId === "string" ? model.modelId : "";
    if (body.model !== undefined && (!providerId || !modelId)) {
      return json(
        { error: "model.providerId and model.modelId required" },
        400,
      );
    }
    const builtinTools = Array.isArray(body.builtinTools)
      ? body.builtinTools.map(String)
      : undefined;
    return json(
      await product.createSession({
        title: typeof body.title === "string" ? body.title : undefined,
        labels: asStringMap(body.labels),
        selectedContext: body.selectedContext
          ? (asObject(body.selectedContext) as ProductSessionMeta["selectedContext"])
          : undefined,
        model:
          providerId && modelId ? { providerId, modelId } : undefined,
        builtinTools,
      }),
      201,
    );
  }
  if (method === "GET" && id === "status" && parts.length === 3) {
    return json({ sessions: await product.sessionStatus() });
  }
  if (!id) {
    return json({ ok: false }, 404);
  }

  if (method === "GET" && parts.length === 3) {
    return json(await product.getSession(id));
  }
  if (method === "PATCH" && parts.length === 3) {
    const body = await readJson(request);
    return json(
      await product.patchSession(id, {
        title: typeof body.title === "string" ? body.title : undefined,
        labels: asStringMap(body.labels),
        selectedContext: body.selectedContext
          ? (asObject(body.selectedContext) as ProductSessionMeta["selectedContext"])
          : undefined,
        shareMetadata:
          body.shareMetadata && typeof body.shareMetadata === "object"
            ? (body.shareMetadata as Record<string, unknown>)
            : undefined,
        rememberedPermissions:
          body.rememberedPermissions &&
          typeof body.rememberedPermissions === "object"
            ? (body.rememberedPermissions as Record<string, "allow" | "deny">)
            : undefined,
      }),
    );
  }
  if (method === "DELETE" && parts.length === 3) {
    await product.deleteSession(id);
    return json({ ok: true });
  }

  if (method === "POST" && action === "prompt") {
    const parsed = await readPromptBody(request);
    if (!parsed.ok) {
      return promptBodyError(parsed);
    }
    const result = await product.prompt(
      { text: parsed.text, files: parsed.files },
      { thebeSessionId: id, mode: parsed.mode },
    );
    return json({
      text: result.text,
      tools: result.tools,
      thebeSessionId: result.thebeSessionId,
    });
  }
  if (method === "GET" && action === "message" && !extra) {
    const messages = await product.loadMessages(id);
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
      const end = found;
      const start = Math.max(0, end - limitResult.limit);
      const sliced = messages.slice(start, end);
      return json({
        messages: sliced,
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
  if (method === "GET" && action === "message" && extra) {
    const message = await product.message(id, extra);
    if (!message) {
      return json({ error: "message not found" }, 404);
    }
    return json(message);
  }
  if (method === "GET" && action === "log") {
    const afterResult = parseLogCursor(request, url);
    if (!afterResult.ok) {
      return json({ error: afterResult.error }, 400);
    }
    if (url.searchParams.get("follow") === "true") {
      return sessionLogStream(product, id, request, afterResult.after);
    }
    const events = product.events(id);
    const sliced = events.slice(afterResult.after);
    return json({ events: sliced, next: events.length });
  }
  if (method === "POST" && action === "interrupt") {
    await product.interrupt(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "permission" && extra) {
    const body = await readJson(request);
    const response =
      body.response === "deny"
        ? "deny"
        : body.response === "allow"
          ? "allow"
          : null;
    if (!response) {
      return json(
        { ok: false, error: "response must be 'allow' or 'deny'" },
        400,
      );
    }
    await product.resolvePermission(id, extra, {
      response,
      remember: Boolean(body.remember),
    });
    return json({ ok: true });
  }
  if (method === "GET" && action === "context") {
    return json(await product.getContext(id));
  }
  if (method === "POST" && action === "tool-call" && parts[5] === "stop") {
    const toolCallId = parts[4] ?? "";
    await product.stopToolCall(id, toolCallId);
    return json({ ok: true });
  }
  if (method === "GET" && action === "background-task" && !extra) {
    return json({ tasks: await product.listBackgroundTasks(id) });
  }
  if (method === "POST" && action === "background-task" && parts[5] === "stop") {
    const taskId = parts[4] ?? "";
    await product.stopBackgroundTask(id, taskId);
    return json({ ok: true });
  }
  if (method === "POST" && action === "background-task" && extra === "stop-all") {
    await product.stopAllBackgroundTasks(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "fork") {
    const body = await readJson(request);
    const messageID =
      typeof body.messageID === "string"
        ? body.messageID
        : typeof body.messageId === "string"
          ? body.messageId
          : undefined;
    const mode =
      body.mode === "branch_in_place" ? "branch_in_place" : "new_session";
    return json(await product.fork(id, { atEntryId: messageID, mode }), 201);
  }
  if (method === "GET" && action === "children") {
    return json({ sessions: await product.children(id) });
  }
  if (method === "POST" && action === "revert") {
    await product.revert(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "unrevert") {
    await product.unrevert(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "compact") {
    const body = await readJson(request);
    const instructions =
      typeof body.customInstructions === "string"
        ? body.customInstructions
        : undefined;
    try {
      await product.compact(id, instructions);
      return json({ ok: true, compacted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("Nothing to compact") ||
        message.includes("Already compacted")
      ) {
        return json({ ok: true, compacted: false, message });
      }
      throw error;
    }
  }
  if (method === "POST" && action === "model") {
    const body = await readJson(request);
    const model = asObject(body.model);
    const providerId =
      typeof model.providerId === "string" ? model.providerId : "";
    const modelId = typeof model.modelId === "string" ? model.modelId : "";
    if (!providerId || !modelId) {
      return json({ error: "model.providerId and model.modelId required" }, 400);
    }
    await product.setModel(id, { providerId, modelId });
    return json({ ok: true });
  }
  if (method === "POST" && action === "thinking") {
    const body = await readJson(request);
    const level = parseThinkingLevel(body.level);
    if (!level) {
      return json(
        {
          error:
            "invalid thinking level; want off, minimal, low, medium, high, xhigh, or max",
        },
        400,
      );
    }
    await product.setThinkingLevel(id, level);
    return json({ ok: true });
  }
  if (method === "GET" && action === "export") {
    const format = url.searchParams.get("format");
    const exported = await product.exportSession(id);
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
  if (method === "GET" && action === "diff") {
    return json(
      {
        ok: false,
        code: "feature_not_implemented",
        error: "session diff is not implemented",
      },
      501,
    );
  }
  if (action === "share") {
    if (method === "POST") {
      return json(
        await product.patchSession(id, {
          shareMetadata: { shared: true },
        }),
      );
    }
    if (method === "DELETE") {
      return json(
        await product.patchSession(id, {
          shareMetadata: { shared: false },
        }),
      );
    }
  }
  return json({ ok: false }, 404);
}
