export type CliModel = { providerId: string; modelId: string };

export type CliCommand =
  | { kind: "help" }
  | { kind: "doctor" }
  | {
      kind: "tui";
      sessionId?: string;
      continueLast?: boolean;
      title?: string;
      model?: CliModel;
      tuiMode?: "regular" | "fullscreen";
    }
  | {
      kind: "print";
      text: string;
      sessionId?: string;
      continueLast?: boolean;
      title?: string;
      model?: CliModel;
      thinking?: string;
      mode?: "prompt" | "steer" | "followUp";
    }
  | { kind: "list-models"; providerId?: string; all?: boolean; search?: string }
  | { kind: "session-list" }
  | { kind: "session-create"; title?: string; model?: CliModel }
  | { kind: "session-resume"; sessionId: string }
  | { kind: "session-fork"; sessionId?: string; atEntryId?: string }
  | { kind: "session-compact"; sessionId?: string }
  | {
      kind: "session-export";
      sessionId?: string;
      format: "jsonl" | "html" | "both";
      out?: string;
    }
  | { kind: "session-delete"; sessionId: string }
  | { kind: "session-messages"; sessionId?: string }
  | { kind: "session-status" }
  | { kind: "session-interrupt"; sessionId?: string }
  | { kind: "session-revert"; sessionId?: string }
  | { kind: "session-unrevert"; sessionId?: string }
  | { kind: "session-model"; sessionId: string; model: CliModel }
  | { kind: "session-thinking"; sessionId: string; level: string }
  | { kind: "error"; message: string };
