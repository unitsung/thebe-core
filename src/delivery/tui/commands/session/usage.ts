import type { ThebeAgent, ThebeSessionContext } from "../../../../agent/index.ts";
import { chalk } from "../../theme.ts";
import { formatTokens } from "../../display/format.ts";
import type { SlashHost } from "../context.ts";

export async function handleUsageCommand(
  host: SlashHost,
  agent: ThebeAgent,
): Promise<void> {
  const id = await host.ensureSession();
  const meta = await agent.getSession(id);
  let u = { usedTokens: host.contextTokensUsed, maxTokens: host.contextWindowTotal };
  let compaction: ThebeSessionContext["compaction"] = {
    nearThreshold: false,
    lastCompactedAt: undefined,
  };
  let estimatedCost: { amount: number; currency: string } | undefined;
  let ctxStats: ThebeSessionContext["sessionStats"];
  let sessionName: string | undefined = meta.title;
  try {
    const ctx = await agent.getContextUsage(id);
    u = ctx.contextUsage;
    compaction = ctx.compaction;
    estimatedCost = ctx.estimatedCost;
    ctxStats = ctx.sessionStats;
    if (ctx.sessionName) sessionName = ctx.sessionName;
  } catch {}
  const msgs = await agent.loadMessages(id);

  // Calculate turns and message counts
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let messageInputTokens = 0;
  let messageOutputTokens = 0;
  let messageCacheReadTokens = 0;
  let messageCacheWriteTokens = 0;

  for (const m of msgs) {
    if (m.role === "user") {
      userTurns += 1;
    } else if (m.role === "assistant") {
      assistantTurns += 1;
      if (Array.isArray((m as { content?: unknown[] }).content)) {
        for (const c of (m as { content?: Array<{ type?: string }> }).content ?? []) {
          if (c?.type === "toolCall") toolCalls += 1;
        }
      }
    } else if (m.role === "tool" || (m as { toolName?: string }).toolName) {
      toolCalls += 1;
    }
    if (m.role === "tool" || (m as { role?: string }).role === "toolResult") {
      toolResults += 1;
    }
    // If runtime message contains nested usage stats
    const rawUsage = (m as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (rawUsage) {
      messageInputTokens += rawUsage.input ?? 0;
      messageOutputTokens += rawUsage.output ?? 0;
      messageCacheReadTokens += rawUsage.cacheRead ?? 0;
      messageCacheWriteTokens += rawUsage.cacheWrite ?? 0;
    }
  }

  const userMessagesCount = ctxStats ? ctxStats.userMessages : userTurns;
  const assistantMessagesCount = ctxStats ? ctxStats.assistantMessages : assistantTurns;
  const toolCallsCount = ctxStats ? ctxStats.toolCalls : toolCalls;
  const toolResultsCount = ctxStats ? ctxStats.toolResults : toolResults;
  const totalMessagesCount = ctxStats ? ctxStats.totalMessages : msgs.length;
  const totalTurns = userMessagesCount + assistantMessagesCount;

  const effectiveInputTokens = ctxStats
    ? ctxStats.tokens.input
    : messageInputTokens;
  const effectiveOutputTokens = ctxStats
    ? ctxStats.tokens.output
    : messageOutputTokens;
  const effectiveCacheRead = ctxStats
    ? ctxStats.tokens.cacheRead
    : messageCacheReadTokens;
  const effectiveCacheWrite = ctxStats
    ? ctxStats.tokens.cacheWrite
    : messageCacheWriteTokens;
  const promptTokens =
    effectiveInputTokens + effectiveCacheRead + effectiveCacheWrite;
  const totalTokens = ctxStats
    ? ctxStats.tokens.total
    : promptTokens + effectiveOutputTokens;

  // Cache hit rate: cacheRead / promptTokens
  const cacheHitRate =
    promptTokens > 0 ? (effectiveCacheRead / promptTokens) * 100 : 0;

  const pct = u.maxTokens > 0 ? (u.usedTokens / u.maxTokens) * 100 : 0;
  const barWidth = 24;
  const filled = Math.min(
    barWidth,
    Math.max(0, Math.round((pct / 100) * barWidth)),
  );
  const empty = barWidth - filled;
  const meter = `[${chalk.cyan("█".repeat(filled))}${chalk.dim("░".repeat(empty))}] ${pct.toFixed(1)}%`;

  const sessionFile = ctxStats?.sessionFile ?? "In-memory";
  const costAmount = ctxStats?.cost ?? (estimatedCost?.amount ?? 0);

  const lines = [
    chalk.cyan("─── Token & Usage Details ──────────────────────────────────────"),
    chalk.bold("Session Info:"),
    sessionName ? `  Name:            ${sessionName}` : undefined,
    `  File:            ${sessionFile}`,
    `  ID:              ${meta.thebeSessionId}`,
    `  Model:           ${host.currentModel} · Thinking: ${host.currentThinking}`,
    "",
    chalk.bold("Messages:"),
    `  Total:           ${totalMessagesCount}`,
    `  User:            ${userMessagesCount}`,
    `  Assistant:       ${assistantMessagesCount}`,
    `  Tools:           ${toolCallsCount} calls, ${toolResultsCount} results`,
    `  Total Turns:     ${totalTurns} (User: ${userMessagesCount} · Assistant: ${assistantMessagesCount})`,
    "",
    chalk.bold("Tokens:"),
    `  Input:           ${formatTokens(promptTokens)} (${promptTokens.toLocaleString()})`,
  ];
  if (
    promptTokens > 0 &&
    (effectiveCacheRead > 0 || effectiveCacheWrite > 0)
  ) {
    const hitRate = chalk.cyan(`(${cacheHitRate.toFixed(1)}%)`);
    lines.push(
      `    Cached:        ${formatTokens(effectiveCacheRead)} (${effectiveCacheRead.toLocaleString()}) ${hitRate}`,
    );
    const written =
      effectiveCacheWrite > 0
        ? chalk.dim(
            ` (${effectiveCacheWrite.toLocaleString()} written to cache)`,
          )
        : "";
    lines.push(
      `    Uncached:      ${formatTokens(effectiveInputTokens + effectiveCacheWrite)} (${(effectiveInputTokens + effectiveCacheWrite).toLocaleString()})${written}`,
    );
  }
  lines.push(
    `  Output:          ${formatTokens(effectiveOutputTokens)} (${effectiveOutputTokens.toLocaleString()})`,
    `  Total Tokens:    ${formatTokens(totalTokens)} (${totalTokens.toLocaleString()})`,
    `  Cached Tokens:   Read: ${formatTokens(effectiveCacheRead)} (${effectiveCacheRead.toLocaleString()}) · Write: ${formatTokens(effectiveCacheWrite)} (${effectiveCacheWrite.toLocaleString()})`,
    `  Cache Hit Rate:  ${chalk.cyan(cacheHitRate.toFixed(1) + "%")} (${effectiveCacheRead.toLocaleString()} of ${promptTokens.toLocaleString()} prompt tokens)`,
    "",
    chalk.bold("Context Window:"),
    `  Context Bar:     ${meter}`,
    `  Usage:           ${formatTokens(u.usedTokens)} / ${formatTokens(u.maxTokens)} tokens (${u.usedTokens.toLocaleString()} / ${u.maxTokens.toLocaleString()})`,
    "",
    chalk.bold("Cost & Compaction:"),
    `  Total Cost:      $${costAmount.toFixed(3)}${estimatedCost && !ctxStats ? ` ${estimatedCost.currency}` : ""}`,
    `  Auto-Compaction: ${compaction.enabled === false ? chalk.yellow("Off") : chalk.green("On")} · Near Threshold: ${compaction.nearThreshold ? chalk.yellow("YES (approaching limit)") : chalk.green("No")}${compaction.lastCompactedAt ? ` · Last: ${compaction.lastCompactedAt.slice(0, 19).replace("T", " ")}` : ""}`,
    chalk.cyan("────────────────────────────────────────────────────────────────"),
  );
  host.notice(lines.filter(Boolean).join("\n"));
}
