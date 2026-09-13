import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { asObject, asStringMap, json, readJson } from "../json.ts";
import { promptBodyError } from "../parsing/errors.ts";
import { parseThinkingLevel } from "../parsing/query.ts";
import { readPromptBody } from "../parsing/prompt.ts";

type Agent = NonNullable<ThebeHttpContext["agent"]>;
type SessionCreateInput = NonNullable<Parameters<Agent["createSession"]>[0]>;
type SessionPatchInput = Parameters<Agent["patchSession"]>[1];

/** Session creation, mutation, prompting, and command routes. */
export async function handleSessionCommands(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  const { request, parts, agent } = context;
  if (!agent || parts[0] !== "v1" || parts[1] !== "session") {
    return undefined;
  }
  const method = request.method;
  const id = parts[2];
  const action = parts[3];
  const extra = parts[4];

  // During maintenance, reads remain available and the two controls needed
  // to finish an in-flight run (interrupt and permission) remain usable.
  if (method !== "GET" && action !== "interrupt" && action !== "permission") {
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
  }

  if (method === "POST" && parts.length === 2) {
    return createSession(request, agent);
  }
  if (!id) {
    return undefined;
  }
  if (method === "PATCH" && parts.length === 3) {
    const body = await readJson(request);
    const patch: SessionPatchInput = {
      title: typeof body.title === "string" ? body.title : undefined,
      labels: asStringMap(body.labels),
      selectedContext: body.selectedContext
        ? (asObject(body.selectedContext) as SessionPatchInput["selectedContext"])
        : undefined,
      shareMetadata:
        body.shareMetadata && typeof body.shareMetadata === "object"
          ? (body.shareMetadata as SessionPatchInput["shareMetadata"])
          : undefined,
      rememberedPermissions:
        body.rememberedPermissions &&
        typeof body.rememberedPermissions === "object"
          ? (body.rememberedPermissions as SessionPatchInput["rememberedPermissions"])
          : undefined,
    };
    return json(await agent.patchSession(id, patch));
  }
  if (method === "DELETE" && parts.length === 3) {
    await agent.deleteSession(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "prompt") {
    const parsed = await readPromptBody(request);
    if (!parsed.ok) {
      return promptBodyError(parsed);
    }
    if (parsed.mode === "prompt" && agent.isBusy(id)) {
      return json(
        {
          ok: false,
          error: "session is streaming; use steer or followUp",
          code: "session_running",
        },
        409,
      );
    }
    const result = await agent.prompt(
      { text: parsed.text, files: parsed.files },
      { thebeSessionId: id, mode: parsed.mode },
    );
    return json({
      text: result.text,
      tools: result.tools,
      thebeSessionId: result.thebeSessionId,
    });
  }
  if (method === "POST" && action === "interrupt") {
    await agent.interrupt(id);
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
    await agent.resolvePermission(id, extra, {
      response,
      remember: Boolean(body.remember),
      rememberScope:
        body.rememberScope === "tool"
          ? "tool"
          : body.rememberScope === "conversation"
            ? "conversation"
            : "request",
    });
    return json({ ok: true });
  }
  if (method === "POST" && action === "tool-call" && parts[5] === "stop") {
    if (!extra) {
      return json({ ok: false, error: "toolCallId is required" }, 400);
    }
    await agent.stopToolCall(id, extra);
    return json({ ok: true });
  }
  if (method === "POST" && action === "background-task") {
    if (extra === "stop-all" && parts.length === 5) {
      await agent.stopAllBackgroundTasks(id);
      return json({ ok: true });
    }
    if (extra && parts[5] === "stop" && parts.length === 6) {
      await agent.stopBackgroundTask(id, extra);
      return json({ ok: true });
    }
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
    return json(await agent.fork(id, { atEntryId: messageID, mode }), 201);
  }
  if (method === "POST" && action === "revert") {
    await agent.revert(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "unrevert") {
    await agent.unrevert(id);
    return json({ ok: true });
  }
  if (method === "POST" && action === "compact") {
    const body = await readJson(request);
    const instructions =
      typeof body.customInstructions === "string"
        ? body.customInstructions
        : undefined;
    try {
      await agent.compact(id, instructions);
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
    await agent.setModel(id, { providerId, modelId });
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
    return json({ ok: true, thinking: await agent.setThinkingLevel(id, level) });
  }
  if (action === "share") {
    if (method === "POST") {
      return json(await agent.patchSession(id, { shareMetadata: { shared: true } }));
    }
    if (method === "DELETE") {
      return json(await agent.patchSession(id, { shareMetadata: { shared: false } }));
    }
  }
  return undefined;
}

async function createSession(request: Request, agent: Agent): Promise<Response> {
  const body = await readJson(request);
  const model = asObject(body.model);
  const providerId = typeof model.providerId === "string" ? model.providerId : "";
  const modelId = typeof model.modelId === "string" ? model.modelId : "";
  if (body.model !== undefined && (!providerId || !modelId)) {
    return json({ error: "model.providerId and model.modelId required" }, 400);
  }
  const init: SessionCreateInput = {
    title: typeof body.title === "string" ? body.title : undefined,
    labels: asStringMap(body.labels),
    selectedContext: body.selectedContext
      ? (asObject(body.selectedContext) as SessionCreateInput["selectedContext"])
      : undefined,
    model: providerId && modelId ? { providerId, modelId } : undefined,
    builtinTools: Array.isArray(body.builtinTools)
      ? body.builtinTools.map(String)
      : undefined,
  };
  return json(await agent.createSession(init), 201);
}
