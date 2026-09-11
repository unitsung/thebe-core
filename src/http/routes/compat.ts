import type { ThebeProduct } from "../../product/service.ts";
import { json } from "../json.ts";
import {
  productError,
  promptBodyError,
  readPromptBody,
  sessionLogStream,
} from "../parse.ts";

/** POST /v1/messages — prompt body compatibility for older clients. */
export async function handleMessagesCompatibility(
  request: Request,
  product?: ThebeProduct,
): Promise<Response> {
  if (!product) {
    return json({ ok: false, error: "product service unavailable" }, 503);
  }
  try {
    const parsed = await readPromptBody(request);
    if (!parsed.ok) {
      return promptBodyError(parsed);
    }
    let sessionId = parsed.sessionId;
    if (!sessionId) {
      sessionId = (await product.createSession()).thebeSessionId;
    }
    const wantsStream =
      parsed.stream === true ||
      (request.headers.get("accept") ?? "").includes("text/event-stream");
    if (wantsStream) {
      if (
        (parsed.mode ?? "prompt") === "prompt" &&
        product.isStreaming(sessionId)
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
      void product
        .prompt(
          { text: parsed.text, files: parsed.files },
          { thebeSessionId: sessionId, mode: parsed.mode },
        )
        .catch(() => {});
      return sessionLogStream(product, sessionId, request, 0, {
        closeOnTerminal: true,
      });
    }
    const result = await product.prompt(
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
    return productError(error);
  }
}
