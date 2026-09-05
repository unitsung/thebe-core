import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isFailureSentinel } from "../agent-adapter/convert.ts";

export type RunStatus =
  | "running"
  | "done"
  | "failed"
  | "approval_expired"
  | "force-killed";

export type TokenTotals = {
  input: number;
  output: number;
  totalTokens: number;
  estimatedTokens: number;
};

export type RunSnapshot = {
  runId: string;
  timestamp: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: string[];
  status: RunStatus;
  tokenTotals: TokenTotals;
};

const ESTIMATE_SAFETY = 1.3;

export function createRunStore(
  dir?: string,
  now: () => Date = () => new Date(),
) {
  const totals: TokenTotals = {
    input: 0,
    output: 0,
    totalTokens: 0,
    estimatedTokens: 0,
  };

  function charsOf(message: AgentMessage): number {
    try {
      return JSON.stringify((message as { content?: unknown }).content ?? "")
        .length;
    } catch {
      return 0;
    }
  }

  function recordMessages(messages: AgentMessage[]): void {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (isFailureSentinel(message)) continue;
      const stopReason = (message as { stopReason?: string }).stopReason;
      const usage = (
        message as {
          usage?: { input?: number; output?: number; totalTokens?: number };
        }
      ).usage;
      if (stopReason === "aborted" || stopReason === "error") {
        const est = Math.ceil((charsOf(message) / 4) * ESTIMATE_SAFETY);
        totals.estimatedTokens += est;
        totals.totalTokens += est;
        continue;
      }
      if (usage && typeof usage.totalTokens === "number") {
        totals.input += usage.input ?? 0;
        totals.output += usage.output ?? 0;
        totals.totalTokens += usage.totalTokens;
        continue;
      }
      const est = Math.ceil((charsOf(message) / 4) * ESTIMATE_SAFETY);
      totals.estimatedTokens += est;
      totals.totalTokens += est;
    }
  }

  function resetLedger(): void {
    totals.input = 0;
    totals.output = 0;
    totals.totalTokens = 0;
    totals.estimatedTokens = 0;
  }

  function tokenTotals(): TokenTotals {
    return { ...totals };
  }

  function isOverflow(contextWindow: number, reserveMargin = 0): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    return totals.totalTokens >= contextWindow - reserveMargin;
  }

  async function save(
    snapshot: Omit<RunSnapshot, "timestamp" | "tokenTotals">,
  ): Promise<void> {
    if (!dir) {
      return;
    }
    await mkdir(dir, { recursive: true });
    const row: RunSnapshot = {
      ...snapshot,
      tokenTotals: tokenTotals(),
      timestamp: now().toISOString(),
    };
    await writeFile(
      join(dir, `${snapshot.runId}.json`),
      JSON.stringify(row),
      "utf8",
    );
  }

  async function load(runId: string): Promise<RunSnapshot> {
    if (!dir) {
      throw new Error("RunStore has no directory");
    }
    const text = await readFile(join(dir, `${runId}.json`), "utf8");
    return JSON.parse(text) as RunSnapshot;
  }

  async function list(offset = 0, limit = 50): Promise<string[]> {
    if (!dir) {
      return [];
    }
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    return names
      .slice(offset, offset + limit)
      .map((n) => n.replace(/\.json$/, ""));
  }

  return {
    save,
    load,
    list,
    recordMessages,
    resetLedger,
    tokenTotals,
    isOverflow,
  };
}
