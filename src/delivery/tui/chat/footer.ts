import { truncateToWidth, visibleWidth } from "../rendering/adapter.ts";
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
  isBashMode?: boolean;
  isExecutingBash?: boolean;
  isMenuOpen?: boolean;
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

  const parsedModel = parseModelRef(state.model);
  const providerId = parsedModel.providerId;
  const modelId = parsedModel.modelId || state.model || "no model";

  const thinkingSuffix =
    state.thinking === "off" ? " • thinking off" : ` • ${state.thinking}`;
  const rightSideWithoutProvider = `${modelId}${thinkingSuffix}`;
  let rightSide = providerId
    ? `(${providerId}) ${rightSideWithoutProvider}`
    : rightSideWithoutProvider;

  const minPadding = 2;
  let statsLeft = statsParts.join(" ");
  let statsLeftWidth = visibleWidth(statsLeft);

  if (statsLeftWidth > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  // If adding provider exceeds width, drop provider prefix
  if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
    rightSide = rightSideWithoutProvider;
  }

  let statsLine: string;
  const rightSideWidth = visibleWidth(rightSide);
  const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

  if (totalNeeded <= width) {
    const padding = " ".repeat(
      Math.max(0, width - statsLeftWidth - rightSideWidth),
    );
    statsLine = chalk.dim(statsLeft) + padding + chalk.dim(rightSide);
  } else {
    const availableForRight = width - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      // Preserve thinking level when truncating model ID
      const thinkingSuffixWidth = visibleWidth(thinkingSuffix);
      if (availableForRight > thinkingSuffixWidth + 4) {
        const availableForModel = availableForRight - thinkingSuffixWidth;
        const truncatedModel = truncateToWidth(modelId, availableForModel, "…");
        const fittedRight = `${truncatedModel}${thinkingSuffix}`;
        const padding = " ".repeat(
          Math.max(0, width - statsLeftWidth - visibleWidth(fittedRight)),
        );
        statsLine = chalk.dim(statsLeft) + padding + chalk.dim(fittedRight);
      } else {
        const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
        const padding = " ".repeat(
          Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)),
        );
        statsLine = chalk.dim(statsLeft) + padding + chalk.dim(truncatedRight);
      }
    } else {
      statsLine = chalk.dim(statsLeft);
    }
  }

  const lines = [pwdLine, statsLine];

  if (state.isMenuOpen) {
    const menuLabel = `${chalk.dim("✦ ")}${chalk.cyan("Commands")}`;
    const menuHint =
      width >= 75
        ? `${menuLabel}${chalk.dim(" · ↑/↓: navigate · Tab: complete · Enter: select · Esc: dismiss")}`
        : `${menuLabel}${chalk.dim(" · ↑/↓: navigate · Tab/Enter: select · Esc: dismiss")}`;
    lines.push(truncateToWidth(menuHint, width, ""));
  } else if (state.isBashMode) {
    const bashLabel = `${chalk.dim("⚡ ")}${chalk.green("Bash")}`;
    const bashHint =
      width >= 75
        ? `${bashLabel}${chalk.dim(" · Enter: run · Esc: exit · !!: exclude from context")}`
        : `${bashLabel}${chalk.dim(" · Enter: run · Esc: exit")}`;
    lines.push(truncateToWidth(bashHint, width, ""));
  } else if (state.isResponding || state.isExecutingBash) {
    const statusIndicator = state.isExecutingBash
      ? chalk.green("⚡ running bash...")
      : state.activeToolName
        ? chalk.yellow(`● ${state.activeToolName}`)
        : chalk.cyan("● working");
    let respondingHint: string;
    if (width >= 90) {
      respondingHint = `${statusIndicator} ${chalk.dim("· Esc interrupt · Alt+Enter queue · Ctrl+T thinking · Ctrl+O tools · Ctrl+G tasks · Ctrl+Shift+G child")}`;
    } else if (width >= 65) {
      respondingHint = `${statusIndicator} ${chalk.dim("· Esc interrupt · Alt+Enter queue · Ctrl+T/O toggle · Ctrl+G tasks")}`;
    } else {
      respondingHint = `${statusIndicator} ${chalk.dim("· Esc: interrupt")}`;
    }
    lines.push(truncateToWidth(respondingHint, width, ""));
  }

  return lines;
}
