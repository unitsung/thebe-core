import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { agentError } from "../parsing/errors.ts";
import { handleProviderModelAuth } from "./provider.ts";
import { handleSessionCommands } from "./session-commands.ts";
import { handleSessionRead } from "./session-read.ts";

export async function handleAgentRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  if (!context.agent) {
    return agentUnavailable();
  }
  try {
    if (context.request.method === "GET" && context.path === "/v1/capabilities") {
      return json({ capabilities: await context.agent.listCapabilities() });
    }
    const sessionRead = await handleSessionRead(context);
    if (sessionRead) {
      return sessionRead;
    }
    const sessionCommand = await handleSessionCommands(context);
    if (sessionCommand) {
      return sessionCommand;
    }
    return await handleProviderModelAuth(context);
  } catch (error) {
    return agentError(error);
  }
}
