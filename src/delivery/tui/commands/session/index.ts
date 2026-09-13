import type { ThebeAgent } from "../../../../agent/index.ts";
import type { SlashHost } from "../context.ts";
import { handleSessionActions } from "./actions.ts";
import { handleSessionLifecycle } from "./lifecycle.ts";
import { handleUsageCommand } from "./usage.ts";

export async function handleSessionCommand(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string,
): Promise<boolean> {
  if (name === "usage" || name === "session") {
    await handleUsageCommand(host, agent);
    return true;
  }
  if (await handleSessionLifecycle(host, agent, name, arg)) {
    return true;
  }
  if (await handleSessionActions(host, agent, name, arg)) {
    return true;
  }
  return false;
}
