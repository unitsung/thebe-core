import type { TuiMode } from "./rendering/adapter.ts";
import type { ThebeAgent } from "../../agent/index.ts";
import type { ThemeName } from "./theme.ts";

export type ThebeTuiSend = (text: string) => Promise<string>;

export type ThebeOAuthPairingCode = {
  code: string;
  expiresAt: string;
  issuer?: string;
  resource?: string;
};

export type ThebeTuiOptions = {
  agent?: ThebeAgent;
  sessionId?: string;
  title?: string;
  model?: string;
  version?: string;
  /** Simple reply adapter used by unit tests / demos. */
  send?: ThebeTuiSend;
  tuiMode?: TuiMode;
  theme?: ThemeName;
  /** Thebe workspace shown in the TUI and used by direct shell commands. */
  cwd?: string;
  /** Invoked after `/tui` persists a mode so the host can swap the live screen. */
  onTuiModeChange?: (mode: TuiMode) => void | Promise<void>;
  /** Issues a one-time pairing code when the MCP OAuth gateway is enabled. */
  issueOAuthPairingCode?: () =>
    | ThebeOAuthPairingCode
    | Promise<ThebeOAuthPairingCode>;
  /**
   * Stops the OS-sandbox proxies. The host that bootstrapped Core supplies it;
   * delivery never imports the sandbox library (see `architecture.test.ts`).
   */
  disposeSandboxVms?: () => Promise<void>;
};
