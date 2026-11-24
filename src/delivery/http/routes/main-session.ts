import {
  agentUnavailable,
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json } from "../json.ts";
import { agentError, promptBodyError } from "../parsing/errors.ts";
import { readPromptBody } from "../parsing/prompt.ts";
import { PRODUCT_HTTP_PATH, PRODUCT_HTTP_SEGMENT } from "../product-paths.ts";

export async function handleMainSessionRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const base = PRODUCT_HTTP_PATH.mainSession;
  if (context.path !== base && !context.path.startsWith(`${base}/`)) {
    return undefined;
  }
  if (!context.agent) return agentUnavailable();
  const { request, agent } = context;

  try {
    if (context.path === base) {
      if (request.method === "GET") {
        const session = await agent.getMainSession();
        return json({
          id: agent.mainSessionId,
          initialized: Boolean(session),
          ...(session ? { session } : {}),
        });
      }
      return methodNotAllowed();
    }
    if (
      context.path === `${base}/${PRODUCT_HTTP_SEGMENT.messages}` &&
      request.method === "POST"
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const parsed = await readPromptBody(request, {
        runtimeSelection: true,
      });
      if (!parsed.ok) return promptBodyError(parsed);
      const result = await agent.askMainSession(
        { text: parsed.text, files: parsed.files },
        {
          mode: parsed.mode,
          model: parsed.model,
          thinking: parsed.thinking,
        }
      );
      return json({
        text: result.text,
        tools: result.tools,
        thebeSessionId: result.thebeSessionId,
      });
    }
    if (
      context.path === `${base}/${PRODUCT_HTTP_SEGMENT.interrupt}` &&
      request.method === "POST"
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      if (!(await agent.getMainSession())) {
        return json(
          {
            ok: false,
            error: "main Session is not initialized",
            code: "not_found",
          },
          404
        );
      }
      await agent.interrupt(agent.mainSessionId);
      return json({ ok: true });
    }
    if (
      context.path === `${base}/${PRODUCT_HTTP_SEGMENT.messages}` ||
      context.path === `${base}/${PRODUCT_HTTP_SEGMENT.interrupt}`
    ) {
      return methodNotAllowed();
    }
    return undefined;
  } catch (error) {
    return agentError(error);
  }
}

function methodNotAllowed(): Response {
  return json(
    { ok: false, error: "method not allowed", code: "method_not_allowed" },
    405
  );
}
