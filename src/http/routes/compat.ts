import type { ThebeProduct } from "../../product/service.ts";
import { json } from "../json.ts";
import { productError, promptBodyError, readPromptBody } from "../parse.ts";

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
    const result = await product.prompt(
      { text: parsed.text, files: parsed.files },
      { thebeSessionId: parsed.sessionId, mode: parsed.mode },
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
