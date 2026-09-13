import type { Markdown } from "../rendering/adapter.ts";
import type { RuntimeThinkingInfo, ThinkingLevel } from "../../../agent/index.ts";
import type { GoalRun } from "../../../agent/index.ts";
import type { ThemeName } from "../theme.ts";
import type { ElapsedWorking, ThinkingBlock } from "./transcript.ts";
import type { ToolExecutionComponent } from "../rendering/adapter.ts";

export type PendingGoalConclusion = { run: GoalRun; sessionId: string };

/** Mutable chat state shared by the session, event, task, and input modules. */
export class ChatState {
  sessionId: string | undefined;
  sessionTitle: string | undefined;
  currentModel: string;
  currentThinking: ThinkingLevel = "off";
  thinkingInfo: RuntimeThinkingInfo = {
    level: "off",
    availableLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    supportsThinking: true,
  };
  currentTheme: ThemeName;
  contextTokensUsed = 0;
  contextWindowTotal = 1_048_576;
  cumulativeInputTokens = 0;
  cumulativeOutputTokens = 0;
  activeToolName: string | undefined;
  isResponding = false;
  isBashMode = false;
  isExecutingBash = false;
  currentBashAbortController: AbortController | undefined;
  streamUnsub: (() => void) | undefined;
  summaryUnsub: (() => void) | undefined;
  thinkingSyncPromise: Promise<void> | undefined;
  replyMarkdown: Markdown | undefined;
  working: ElapsedWorking | undefined;
  thinkingBlock: ThinkingBlock | undefined;
  hideThinking = true;
  toolsExpanded = false;
  disposed = false;
  historyLoadGeneration = 0;
  sessionCreationPromise: Promise<string> | undefined;
  pendingPermissionId: string | undefined;
  currentGoalRun: GoalRun | undefined;
  readonly pendingGoalConclusions: PendingGoalConclusion[] = [];
  readonly toolComponents = new Map<string, ToolExecutionComponent>();

  constructor(options: { sessionId?: string; title?: string; model?: string; theme?: ThemeName }) {
    this.sessionId = options.sessionId;
    this.sessionTitle = options.title;
    this.currentModel = options.model ?? "";
    this.currentTheme = options.theme ?? "dark";
  }
}
