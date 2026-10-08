import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ThebeAgent, ThinkingLevel } from "../../../agent/index.ts";
import { CLI_HELP, type CliCommand } from "../args.ts";

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
  agent: ThebeAgent,
  command: CliCommand,
  options?: {
    startTui?: (opts: {
      agent: ThebeAgent;
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
      const sessionId = await resolveSessionId(agent, {
        sessionId: command.sessionId,
        continueLast: command.continueLast,
        createIfMissing: false,
        title: command.title,
      });
      await options.startTui({ agent, sessionId, title: command.title });
      return 0;
    }
    case "print": {
      const sessionId = await resolveSessionId(agent, {
        sessionId: command.sessionId,
        continueLast: command.continueLast,
        createIfMissing: true,
        title: command.title,
        model: command.model,
      });
      if (!sessionId) {
        error("no session");
        return 1;
      }
      if (command.model) {
        await agent.setModel(sessionId, command.model);
      }
      if (command.thinking) {
        const level = asThinking(command.thinking);
        if (!level) {
          error(`invalid thinking level: ${command.thinking}`);
          return 2;
        }
        await agent.setThinkingLevel(sessionId, level);
      }
      const result = await agent.prompt(command.text, {
        thebeSessionId: sessionId,
        mode: command.mode,
      });
      log(result.text);
      return 0;
    }
    case "list-models": {
      const rows = command.all
        ? await agent.listModels({
            all: true,
            providerId: command.providerId,
          })
        : await agent.listAvailableModels({
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
      const rows = await agent.listSessions();
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
      const meta = await agent.createSession({
        title: command.title,
        model: command.model,
      });
      log(meta.thebeSessionId);
      return 0;
    }
    case "session-resume": {
      const meta = await agent.resume(command.sessionId);
      log(meta.thebeSessionId);
      return 0;
    }
    case "session-fork": {
      const meta = await agent.fork(command.sessionId, command.atEntryId);
      log(meta.thebeSessionId);
      return 0;
    }
    case "session-compact": {
      try {
        await agent.compact(command.sessionId);
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
      const exported = await agent.exportSession(command.sessionId);
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
      await agent.deleteSession(command.sessionId);
      log(`deleted ${command.sessionId}`);
      return 0;
    }
    case "session-messages": {
      const id =
        command.sessionId ??
        agent.lastThebeSessionId() ??
        (await latestSessionId(agent));
      if (!id) {
        error("no session");
        return 1;
      }
      const messages = await agent.loadMessages(id);
      for (const message of messages) {
        const head = message.toolName
          ? `${message.role}/${message.toolName}`
          : message.role;
        log(`[${message.id}] ${head}: ${message.text}`);
      }
      return 0;
    }
    case "session-interrupt": {
      await agent.interrupt(command.sessionId);
      log("interrupted");
      return 0;
    }
    case "session-revert": {
      await agent.revert(command.sessionId);
      log("reverted");
      return 0;
    }
    case "session-unrevert": {
      await agent.unrevert(command.sessionId);
      log("unreverted");
      return 0;
    }
    case "session-model": {
      await agent.setModel(command.sessionId, command.model);
      log(`${command.model.providerId}/${command.model.modelId}`);
      return 0;
    }
    case "session-thinking": {
      const level = asThinking(command.level);
      if (!level) {
        error(`invalid thinking level: ${command.level}`);
        return 2;
      }
      const applied = await agent.setThinkingLevel(command.sessionId, level);
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

type SessionResolutionOptions = {
  sessionId?: string;
  continueLast?: boolean;
  createIfMissing?: boolean;
  title?: string;
  model?: { providerId: string; modelId: string };
};

async function resolveSessionId(
  agent: ThebeAgent,
  opts: SessionResolutionOptions & { createIfMissing: true },
): Promise<string>;
async function resolveSessionId(
  agent: ThebeAgent,
  opts: SessionResolutionOptions & { createIfMissing: false },
): Promise<string | undefined>;
async function resolveSessionId(
  agent: ThebeAgent,
  opts: SessionResolutionOptions,
): Promise<string | undefined> {
  if (opts.sessionId) {
    const match = await matchSessionId(agent, opts.sessionId);
    await agent.resume(match);
    return match;
  }
  if (opts.continueLast) {
    const latest = await latestSessionId(agent);
    if (latest) {
      await agent.resume(latest);
      return latest;
    }
  }
  const active = agent.lastThebeSessionId();
  if (active) {
    return active;
  }
  if (opts.createIfMissing) {
    const meta = await agent.createSession({
      title: opts.title,
      model: opts.model,
    });
    return meta.thebeSessionId;
  }
  return undefined;
}

async function matchSessionId(
  agent: ThebeAgent,
  partial: string,
): Promise<string> {
  const rows = await agent.listSessions();
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
  agent: ThebeAgent,
): Promise<string | undefined> {
  const rows = await agent.listSessions();
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
