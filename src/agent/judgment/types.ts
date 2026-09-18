export type JudgmentQuestion =
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    };

export type JudgmentAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
    };

export type JudgmentRequest = {
  siteId: string;
  state: unknown;
  questions: Record<string, JudgmentQuestion>;
};

export type JudgmentResult = {
  adapter: "jev";
  model: string;
  answers: Record<string, JudgmentAnswer>;
};

export type JudgmentTraditionalPath =
  | "deterministic"
  | "chat_model"
  | "deterministic_then_chat";

export type JudgmentSite = {
  id: string;
  traditionalPath: JudgmentTraditionalPath;
  questions: Record<string, JudgmentQuestion>;
};

export type JudgmentEnabledSites = "all" | readonly string[];

export type JudgmentTrace = {
  siteId: string;
  used: boolean;
  path: "judgment" | "traditional";
  adapter?: "jev";
  answers?: Record<string, JudgmentAnswer>;
  error?: string;
};

export type JudgmentGate =
  | { adapter: "off" }
  | {
      adapter: "jev";
      apiKey: string;
      baseUrl: string;
      model: string;
      sites: JudgmentEnabledSites;
    };
