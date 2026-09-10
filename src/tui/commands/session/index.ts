import type { ThebeProduct } from "../../../product/service.ts";
import type { SlashHost } from "../context.ts";
import { handleSessionActions } from "./actions.ts";
import { handleSessionLifecycle } from "./lifecycle.ts";
import { handleUsageCommand } from "./usage.ts";

export async function handleSessionCommand(
  host: SlashHost,
  product: ThebeProduct,
  name: string,
  arg: string,
): Promise<boolean> {
  if (name === "usage" || name === "session") {
    await handleUsageCommand(host, product);
    return true;
  }
  if (await handleSessionLifecycle(host, product, name, arg)) {
    return true;
  }
  if (await handleSessionActions(host, product, name, arg)) {
    return true;
  }
  return false;
}
