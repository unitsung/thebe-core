import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ThebeProduct } from "../product/service.ts";
import type { ThinkingLevel } from "../runtime/types.ts";
import { CLI_HELP, type CliCommand } from "./args.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export async function runCliCommand(
  product: ThebeProduct,
  command: CliCommand,
  options?: {
    startTui?: (opts: {
      product: ThebeProduct;
      sessionId?: string;
      title?: string;
    }) => void | Promise<void>;
    log?: (line: string) => void;
    error?: (line: string) => void;
  },
): Promise<number> {
  const log = options?.log ?? ((line) => console.log(line));
  const error = options?.error ?? ((line) => console.error(line));

  switch (command.kind) {
    case "help":
      log(CLI_HELP.trimEnd());
      return 0;
    case "error":
      error(command.message);
      error("Try `thebe --help`.");
      return 2;
    case "tui": {
      if (!options?.startTui) {
        error("TUI is not available in this context");
        return 1;
      }
      const sessionId = await resolveSessionId(product, {
        sessionId: command.sessionId,
        continueLast: command.continueLast,
        createIfMissing: true,
        title: command.title,
      });
      await options.startTui({ product, sessionId, title: command.title });
      return 0;
    }
    case "print": {
      const sessionId = await resolveSessionId(product, {
        sessionId: command.sessionId,
        continueLast: command.continueLast,
        createIfMissing: true,
        title: command.title,
        model: command.model,
      });
      if (command.model) {
        await product.setModel(sessionId, command.model);
      }
      if (command.thinking) {
        const level = asThinking(command.thinking);
        if (!level) {
          error(`invalid thinking level: ${command.thinking}`);
          return 2;
        }
        await product.setThinkingLevel(sessionId, level);
      }
      const result = await product.prompt(command.text, {
        thebeSessionId: sessionId,
        mode: command.mode,
      });
      log(result.text);
      return 0;
    }
    case "list-models": {
      const rows = command.all
        ? await product.listModels({
            all: true,
            providerId: command.providerId,
          })
        : await product.listAvailableModels({
            providerId: command.providerId,
          });
      const filtered = command.search
        ? rows.filter((row) => {
            const hay = `${row.providerId}/${row.modelId} ${row.displayName ?? ""}`.toLowerCase();
            return hay.includes(command.search!.toLowerCase());
          })
        : rows;
      for (const row of filtered) {
        const mark = row.available === false ? " (unavailable)" : "";
        log(
          `${row.providerId}/${row.modelId}${row.displayName ? `  ${row.displayName}` : ""}${mark}`,
        );
      }
      return 0;
    }
    case "session-list":
    case "session-status": {
      const rows = await product.listSessions();
      if (rows.length === 0) {
        log("(no sessions)");
        return 0;
      }
      for (const row of rows) {
        log(
          [
            row.thebeSessionId,
            row.status,
            row.streaming ? "streaming" : "idle-io",
            row.title ?? "-",
            row.lastActiveAt ?? row.updatedAt ?? row.createdAt ?? "",
          ].join("\t"),
        );
      }
      return 0;
    }
    case "session-create": {
      const defaultModel = command.model ?? {
        providerId: "opencode",
        modelId: "muse-spark-1.3-free",
      };
      const meta = await product.createSession({
        title: command.title,
        model: defaultModel,
      });
      log(meta.thebeSessionId);
      return 0;
    }
    case "session-resume": {
      const meta = await product.resume(command.sessionId);
      log(meta.thebeSessionId);
      return 0;
    }
    case "session-fork": {
      const meta = await product.fork(command.sessionId, command.atEntryId);
      log(meta.thebeSessionId);
      return 0;
    }
    case "session-compact": {
      try {
        await product.compact(command.sessionId);
        log("compacted");
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("Nothing to compact") ||
          message.includes("Already compacted")
        ) {
          log(message);
          return 0;
        }
        throw error;
      }
    }
    case "session-export": {
      const exported = await product.exportSession(command.sessionId);
      if (command.format === "jsonl" || command.format === "both") {
        const path = exportPath(command.out, "jsonl");
        if (path) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, exported.jsonl, "utf8");
          log(`wrote ${path}`);
        } else {
          log(exported.jsonl);
        }
      }
      if (command.format === "html" || command.format === "both") {
        const path = exportPath(command.out, "html");
        if (path) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, exported.html, "utf8");
          log(`wrote ${path}`);
        } else if (command.format === "html") {
          log(exported.html);
        }
      }
      return 0;
    }
    case "session-delete": {
      await product.deleteSession(command.sessionId);
      log(`deleted ${command.sessionId}`);
      return 0;
    }
    case "session-messages": {
      const id =
        command.sessionId ??
        product.lastThebeSessionId() ??
        (await latestSessionId(product));
      if (!id) {
        error("no session");
        return 1;
      }
      const messages = await product.loadMessages(id);
      for (const message of messages) {
        const head = message.toolName
          ? `${message.role}/${message.toolName}`
          : message.role;
        log(`[${message.id}] ${head}: ${message.text}`);
      }
      return 0;
    }
    case "session-interrupt": {
      await product.interrupt(command.sessionId);
      log("interrupted");
      return 0;
    }
    case "session-revert": {
      await product.revert(command.sessionId);
      log("reverted");
      return 0;
    }
    case "session-unrevert": {
      await product.unrevert(command.sessionId);
      log("unreverted");
      return 0;
    }
    case "session-model": {
      await product.setModel(command.sessionId, command.model);
      log(`${command.model.providerId}/${command.model.modelId}`);
      return 0;
    }
    case "session-thinking": {
      const level = asThinking(command.level);
      if (!level) {
        error(`invalid thinking level: ${command.level}`);
        return 2;
      }
      const applied = await product.setThinkingLevel(command.sessionId, level);
      log(applied.level);
      return 0;
    }
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      error("unhandled command");
      return 1;
    }
  }
}

async function resolveSessionId(
  product: ThebeProduct,
  opts: {
    sessionId?: string;
    continueLast?: boolean;
    createIfMissing?: boolean;
    title?: string;
    model?: { providerId: string; modelId: string };
  },
): Promise<string> {
  if (opts.sessionId) {
    const match = await matchSessionId(product, opts.sessionId);
    await product.resume(match);
    return match;
  }
  if (opts.continueLast) {
    const latest = await latestSessionId(product);
    if (latest) {
      await product.resume(latest);
      return latest;
    }
  }
  const active = product.lastThebeSessionId();
  if (active) {
    return active;
  }
  if (opts.createIfMissing) {
    const defaultModel = opts.model ?? {
      providerId: "opencode",
      modelId: "muse-spark-1.3-free",
    };
    const meta = await product.createSession({
      title: opts.title,
      model: defaultModel,
    });
    return meta.thebeSessionId;
  }
  throw new Error("no session");
}

async function matchSessionId(
  product: ThebeProduct,
  partial: string,
): Promise<string> {
  const rows = await product.listSessions();
  const exact = rows.find((row) => row.thebeSessionId === partial);
  if (exact) {
    return exact.thebeSessionId;
  }
  const matches = rows.filter((row) =>
    row.thebeSessionId.startsWith(partial),
  );
  if (matches.length === 1) {
    return matches[0]!.thebeSessionId;
  }
  if (matches.length === 0) {
    throw new Error(`unknown session: ${partial}`);
  }
  throw new Error(
    `ambiguous session id ${partial}; matches ${matches.map((m) => m.thebeSessionId).join(", ")}`,
  );
}

async function latestSessionId(
  product: ThebeProduct,
): Promise<string | undefined> {
  const rows = await product.listSessions();
  if (rows.length === 0) {
    return undefined;
  }
  const sorted = [...rows].sort((a, b) => {
    const aTime = a.lastActiveAt ?? a.updatedAt ?? a.createdAt ?? "";
    const bTime = b.lastActiveAt ?? b.updatedAt ?? b.createdAt ?? "";
    return bTime.localeCompare(aTime);
  });
  return sorted[0]?.thebeSessionId;
}

function exportPath(
  out: string | undefined,
  ext: "jsonl" | "html",
): string | undefined {
  if (!out) {
    return undefined;
  }
  const resolved = resolve(out);
  if (out.endsWith(".jsonl") || out.endsWith(".html")) {
    return resolved;
  }
  return `${resolved}.${ext}`;
}

function asThinking(value: string): ThinkingLevel | undefined {
  return THINKING_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}
