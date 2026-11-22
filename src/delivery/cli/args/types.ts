export type CliModel = { providerId: string; modelId: string };

export type StorageCliBackend =
  | {
      id: string;
      type: "openlist";
      baseUrl: string;
      token?: string;
    }
  | {
      id: string;
      type: "local";
      roots: string[];
    }
  | {
      id: string;
      type: "webdav";
      url: string;
      username?: string;
      password?: string;
      token?: string;
    };

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
  | { kind: "mcp-list" }
  | { kind: "mcp-tools" }
  | {
      kind: "mcp-add";
      name: string;
      url?: string;
      command?: string;
      args: string[];
      env: Record<string, string>;
      headers: Record<string, string>;
    }
  | { kind: "mcp-enable"; name: string }
  | { kind: "mcp-disable"; name: string }
  | { kind: "mcp-remove"; name: string }
  | { kind: "storage-list" }
  | {
      kind: "storage-add";
      backend: StorageCliBackend;
      makeDefault?: boolean;
    }
  | { kind: "storage-remove"; id: string }
  | { kind: "storage-default"; id: string }
  | { kind: "storage-test"; id?: string }
  | { kind: "storage-import-env" }
  | { kind: "error"; message: string };
