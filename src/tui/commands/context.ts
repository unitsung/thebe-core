import type { Editor, Markdown, TUI } from "@earendil-works/pi-tui";
import type { ThebeProduct } from "../../product/service.ts";
import type { ThinkingLevel } from "../../runtime/types.ts";
import type { ThemeName } from "../theme.ts";
import type { ThebeTuiOptions } from "../types.ts";
import type { FooterDock } from "../display/footer.ts";

export type SlashHost = {
  tui: TUI;
  editor: Editor;
  options: ThebeTuiOptions;
  product: ThebeProduct | undefined;
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
  ensureSession: () => string;
  loadAndDisplaySessionHistory: (id: string) => Promise<void>;
  clearMessagesView: () => void;
  refreshContextUsage: () => Promise<void>;
  updateFooter: () => void;
  updateEditorBorderColor: () => void;
  applyTheme: (name: ThemeName, persist?: boolean) => Promise<void>;
  applyModel: (
    id: string,
    selected: { providerId: string; modelId: string; displayName?: string },
  ) => Promise<void>;
  insertBeforeFooter: (child: unknown) => void;
  makeMarkdown: (text: string) => Markdown;
  getActiveSelectListTheme: () => import("@earendil-works/pi-tui").SelectListTheme;
  runCustomProviderWizard: (
    initialProviderId?: string,
  ) => Promise<{ providerId: string; modelId: string } | null>;
  afterProviderLoggedIn: (
    providerId: string,
    actionLabel: string,
    preferredModelId?: string,
  ) => Promise<void>;
};
