import type { Editor, Markdown, TUI } from "../rendering/adapter.ts";
import type { ThebeAgent } from "../../../agent/index.ts";
import type {
  NormalizedEvent,
  RuntimeThinkingInfo,
  ThinkingLevel,
} from "../../../agent/index.ts";
import type { ThemeName } from "../theme.ts";
import type { ThebeTuiOptions } from "../types.ts";
import type { FooterDock } from "../display/footer.ts";
import type { GoalEvent, GoalRun } from "../../../agent/index.ts";

export type SlashHost = {
  tui: TUI;
  editor: Editor;
  options: ThebeTuiOptions;
  agent: ThebeAgent | undefined;
  sessionId: string | undefined;
  sessionTitle: string | undefined;
  currentModel: string;
  currentThinking: ThinkingLevel;
  currentTheme: ThemeName;
  contextTokensUsed: number;
  contextWindowTotal: number;
  pendingPermissionId: string | undefined;
  children: TUI["children"];
  footerText: FooterDock;
  notice: (text: string) => void;
  ensureSession: () => Promise<string>;
  loadAndDisplaySessionHistory: (id: string) => Promise<void>;
  clearMessagesView: () => void;
  refreshContextUsage: () => Promise<void>;
  updateFooter: () => void;
  updateEditorBorderColor: () => void;
  setHideThinking: (hidden: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => Promise<RuntimeThinkingInfo>;
  applyTheme: (name: ThemeName, persist?: boolean) => Promise<void>;
  applyModel: (
    id: string,
    selected: { providerId: string; modelId: string; displayName?: string },
  ) => Promise<void>;
  insertBeforeFooter: (child: unknown) => void;
  makeMarkdown: (text: string) => Markdown;
  getActiveSelectListTheme: () => import("../rendering/adapter.ts").SelectListTheme;
  runCustomProviderWizard: (
    initialProviderId?: string,
  ) => Promise<{ providerId: string; modelId: string } | null>;
  afterProviderLoggedIn: (
    providerId: string,
    actionLabel: string,
    preferredModelId?: string,
  ) => Promise<void>;
  updateGoalStatus: (run: GoalRun, event?: GoalEvent) => void;
  watchGoal: (thebeSessionId: string) => void;
  clearGoalStatus: () => void;
  showGoalConclusion: (run: GoalRun, targetSessionId: string) => void;
  openTaskPane: () => void;
  forwardRuntimeEvent: (event: NormalizedEvent) => void;
};
