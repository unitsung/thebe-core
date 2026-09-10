export type PiSession = {
  sessionId: string;
  prompt: (
    text: string,
    options?: {
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
    },
  ) => Promise<void>;
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  compact: (customInstructions?: string) => Promise<unknown>;
  dispose: () => void;
  messages: unknown[];
  setModel: (model: unknown) => Promise<void>;
  setThinkingLevel: (level: string) => void;
  navigateTree: (targetId: string) => Promise<unknown>;
  getUserMessagesForForking: () => Array<{ entryId: string; text: string }>;
  setAutoCompactionEnabled?: (enabled: boolean) => void;
  autoCompactionEnabled?: boolean;
  isStreaming?: boolean;
  sessionManager: {
    getLeafId: () => string | null;
    createBranchedSession: (leaf: string) => string | undefined;
    getEntries: () => Array<{
      type: string;
      id?: string;
      timestamp?: number;
      message?: unknown;
    }>;
    getBranch?: () => Array<{ type: string; timestamp?: number }>;
    appendMessage?: (message: unknown) => void;
  };
  state?: unknown;
};
