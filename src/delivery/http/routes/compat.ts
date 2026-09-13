import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { agentError, promptBodyError } from "../parsing/errors.ts";
import { readPromptBody } from "../parsing/prompt.ts";
import { sessionLogStream } from "../protocol/sse.ts";

/** POST /v1/messages — prompt body compatibility for older clients. */
export async function handleCompatibility(
  context: ThebeHttpContext,
): Promise<Response> {
  const { request, agent } = context;
  if (!agent) {
    return agentUnavailable();
  }
  try {
    const parsed = await readPromptBody(request);
    if (!parsed.ok) {
      return promptBodyError(parsed);
    }
    let sessionId = parsed.sessionId;
    if (!sessionId) {
      sessionId = (await agent.createSession()).thebeSessionId;
    }
    const wantsStream =
      parsed.stream === true ||
      (request.headers.get("accept") ?? "").includes("text/event-stream");
    if (wantsStream) {
      if (
        (parsed.mode ?? "prompt") === "prompt" &&
        agent.isBusy(sessionId)
      ) {
        return json(
          {
            ok: false,
            error: "session is streaming; use steer or followUp",
            code: "session_running",
          },
          409,
        );
      }
      const stream = sessionLogStream(agent, sessionId, request, 0, {
        closeOnTerminal: true,
      });
      void agent
        .prompt(
          { text: parsed.text, files: parsed.files },
          { thebeSessionId: sessionId, mode: parsed.mode },
        )
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          agent.emitLog(sessionId, { type: "error", message });
          agent.emitLog(sessionId, { type: "session_end", text: "" });
        });
      return stream;
    }
    const result = await agent.prompt(
      { text: parsed.text, files: parsed.files },
      {
        thebeSessionId: sessionId,
        mode: parsed.mode,
        nonInteractive: true,
      },
    );
    return json({
      ok: true,
      text: result.text,
      tools: result.tools,
      thebeSessionId: result.thebeSessionId,
    });
  } catch (error) {
    return agentError(error);
  }
}
