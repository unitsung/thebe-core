/**
 * Slash-command router. Category handlers live beside this file.
 * Overlays come from pi-tui (SelectList / SettingsList / Input).
 */
import { resolveSlashName } from "../slash.ts";
import type { SlashHost } from "./context.ts";
import { handleHelpCommand } from "./help.ts";
import { handleSessionCommand } from "./session/index.ts";
import { handleAgentCommand } from "./agent.ts";
import { handleProviderCommand } from "./provider.ts";
import { handleSystemCommand } from "./system.ts";
import { handleThebeCommand } from "./thebe.ts";

export async function dispatchSlash(
  host: SlashHost,
  raw: string,
): Promise<boolean> {
  if (!raw.startsWith("/")) {
    return false;
  }
  // Pi expands explicit skill invocations inside RuntimeSession.prompt().
  // Let those commands pass through instead of treating `skill:name` as an
  // unknown Thebe slash command.
  if (/^\/skill:[^\s]+(?:\s|$)/i.test(raw)) {
    return false;
  }
  const body = raw.slice(1).trim();
  const space = body.indexOf(" ");
  const rawName = (space < 0 ? body : body.slice(0, space)).toLowerCase();
  const name = resolveSlashName(rawName);
  const arg = space < 0 ? "" : body.slice(space + 1).trim();

  if (handleHelpCommand(host, name)) {
    return true;
  }

  const product = host.product;
  if (!product) {
    host.notice("slash session commands need a product-backed TUI");
    return true;
  }

  try {
    if (await handleSessionCommand(host, product, name, arg)) {
      return true;
    }
    if (await handleAgentCommand(host, product, name, arg)) {
      return true;
    }
    if (await handleProviderCommand(host, product, name, arg)) {
      return true;
    }
    if (await handleSystemCommand(host, product, name, arg)) {
      return true;
    }
    if (await handleThebeCommand(host, product, name, arg)) {
      return true;
    }
    host.notice(`unknown command /${name}; type /help for available commands`);
  } catch (error) {
    host.notice(error instanceof Error ? error.message : String(error));
  }
  return true;
}
