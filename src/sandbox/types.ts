export type SandboxMode = "none" | "workspace-jail" | "bwrap" | "gondolin";

export interface SandboxConfig {
  mode: SandboxMode;
  workspacePath: string;
  allowNetwork?: boolean;
  readOnlyHost?: boolean;
  dropCapabilities?: boolean;
  tmpfsSize?: string;
}

export interface WrappedCommandResult {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  mode: SandboxMode;
  appliedSandbox: boolean;
  warning?: string;
}
