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
  const modelId = parsedModel.modelId || state.model || "no model";
  const rightSide = ` ${modelId} • ${state.thinking}`;
  const statsLeft = statsParts.join(" ");

  let statsLine: string;
  if (width < 35) {
    statsLine = chalk.dim(truncateToWidth(statsLeft, width, "..."));
  } else {
    const statsLeftWidth = visibleWidth(statsLeft);
    const availableForRight = width - statsLeftWidth;
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
      respondingHint = `${statusIndicator} ${chalk.dim("· Esc: interrupt · Alt+Enter: queue · Ctrl+T: fold · Ctrl+O: tools")}`;
    } else if (width >= 65) {
      respondingHint = `${statusIndicator} ${chalk.dim("· Esc: interrupt · Alt+Enter: queue · Ctrl+T/O: fold")}`;
    } else {
      respondingHint = `${statusIndicator} ${chalk.dim("· Esc: interrupt")}`;
    }
    lines.push(truncateToWidth(respondingHint, width, ""));
  } else {
    let idleHint: string;
    if (width >= 95) {
      idleHint = chalk.dim("Enter: send · Alt+Enter: queue · /: menu · Ctrl+P: model · Shift+Tab: level · Ctrl+T: fold · Ctrl+O: tools");
    } else if (width >= 70) {
      idleHint = chalk.dim("Enter: send · Alt+Enter: queue · /: menu · Ctrl+P: model · Ctrl+T/O: fold");
    } else if (width >= 50) {
      idleHint = chalk.dim("Enter: send · /: menu · Ctrl+P: model · Esc: cancel");
    } else {
      idleHint = chalk.dim("Enter: send · /: menu");
    }
    lines.push(truncateToWidth(idleHint, width, ""));
  }

  return lines;
}
