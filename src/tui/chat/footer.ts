import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { chalk } from "../theme.ts";
import { formatTokens, formatCwdForFooter } from "../display/format.ts";
import { parseModelRef } from "../overlays/model-ref.ts";

export type ChatFooterState = {
  width: number;
  cwd: string;
  home?: string;
  branch?: string;
  sessionTitle?: string;
  inputTokens: number;
  outputTokens: number;
  contextUsed: number;
  contextWindow: number;
  model: string;
  thinking: string;
  isResponding: boolean;
  activeToolName?: string;
};

/** PWD line + stats/model line (+ optional tool status). */
export function formatFooterLines(state: ChatFooterState): string[] {
  const { width } = state;
  let pwd = formatCwdForFooter(state.cwd, state.home);
  if (state.branch) {
    pwd = `${pwd} (${state.branch})`;
  }
  if (state.sessionTitle) {
    pwd = `${pwd} • ${state.sessionTitle}`;
  }

  const pwdLine = truncateToWidth(chalk.dim(pwd), width, chalk.dim("..."));

  const statsParts: string[] = [];
  if (state.inputTokens > 0) {
    statsParts.push(`↑${formatTokens(state.inputTokens)}`);
  }
  if (state.outputTokens > 0) {
    statsParts.push(`↓${formatTokens(state.outputTokens)}`);
  }

  const autoIndicator = " (auto)";
  let contextPercentDisplay = "";
  if (state.contextWindow > 0) {
    const pct = ((state.contextUsed / state.contextWindow) * 100).toFixed(1);
    contextPercentDisplay = `${pct}%/${formatTokens(state.contextWindow)}${autoIndicator}`;
    if (state.contextUsed / state.contextWindow > 0.9) {
      statsParts.push(chalk.red(contextPercentDisplay));
    } else if (state.contextUsed / state.contextWindow > 0.7) {
      statsParts.push(chalk.yellow(contextPercentDisplay));
    } else {
      statsParts.push(contextPercentDisplay);
    }
  } else {
    contextPercentDisplay = `0.0%/1.0M${autoIndicator}`;
    statsParts.push(contextPercentDisplay);
  }

  const statsLeft = statsParts.join(" ");
  const parsedModel = parseModelRef(state.model);
  const modelId = parsedModel.modelId || state.model || "no model";
  const rightSide = `${modelId} • ${state.thinking}`;

  const minPadding = 2;
  const statsLeftWidth = visibleWidth(statsLeft);
  const rightSideWidth = visibleWidth(rightSide);
  const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

  let statsLine: string;
  if (totalNeeded <= width) {
    const padding = " ".repeat(
      Math.max(0, width - statsLeftWidth - rightSideWidth),
    );
    statsLine = chalk.dim(statsLeft) + padding + chalk.dim(rightSide);
  } else {
    const availableForRight = width - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const padding = " ".repeat(
        Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
      );
      statsLine = chalk.dim(statsLeft) + padding + chalk.dim(truncatedRight);
    } else {
      statsLine = chalk.dim(truncateToWidth(statsLeft, width, "..."));
    }
  }

  const lines = [pwdLine, statsLine];
  if (state.isResponding) {
    const statusStr = state.activeToolName
      ? chalk.yellow(`● tool: ${state.activeToolName}`)
      : chalk.cyan("● thinking...");
    lines.push(statusStr);
  }
  return lines;
}
