/**
 * Report and Attention: how a worker or reviewer tells Core where its work stands, as data instead of
 * text markers. A Report is the latest word from an executor; an Attention is the one question it needs
 * the person to answer. Both are owned by the run that produced them.
 */
export const REPORT_STATES = [
  "progress",
  "waiting",
  "ready",
  "blocked",
  "failed",
  "dropped",
] as const;

/**
 * `progress` still working, `waiting` waiting for the person's answer, `ready` the work is done and
 * checkable, `blocked` cannot go on, `failed` could not be done, `dropped` there was nothing to do.
 */
export type ReportState = (typeof REPORT_STATES)[number];

export type ReportRole = "worker" | "reviewer";

export type Report = {
  state: ReportState;
  summary: string;
  at: string;
  role: ReportRole;
};

/** At most one per run. */
export type Attention = {
  question: string;
  askedAt: string;
  role: ReportRole;
};

export const REPORT_SUMMARY_LIMIT = 600;
export const ATTENTION_QUESTION_LIMIT = 500;

/** What an executor submits, before Core stamps the time and role. */
export type ReportInput = {
  state: ReportState;
  summary: string;
  question?: string;
};

/** The words an executor may use for "there was nothing to do". */
const STATE_ALIASES: Record<string, ReportState> = {
  nothing_to_do: "dropped",
  "nothing-to-do": "dropped",
  nothing: "dropped",
};

/** Reads an executor's arguments; a string says what is wrong so the model can correct itself. */
export function parseReportInput(input: unknown): ReportInput | string {
  if (typeof input !== "object" || input === null)
    return "arguments must be an object";
  const record = input as Record<string, unknown>;
  const raw =
    typeof record.state === "string" ? record.state.trim().toLowerCase() : "";
  const state = (REPORT_STATES as readonly string[]).includes(raw)
    ? (raw as ReportState)
    : STATE_ALIASES[raw];
  if (!state) {
    return `state must be one of ${REPORT_STATES.join(", ")} (dropped means nothing to do)`;
  }
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary)
    return "summary is required: one or two sentences of what you did or found";
  const question =
    typeof record.question === "string" ? record.question.trim() : "";
  if (question && state !== "waiting" && state !== "blocked") {
    return "question is only for state waiting or blocked, and it must be one question";
  }
  if (state === "waiting" && !question) {
    return "state waiting needs one question for the owner";
  }
  return {
    state,
    summary: bounded(summary, REPORT_SUMMARY_LIMIT),
    ...(question
      ? { question: bounded(question, ATTENTION_QUESTION_LIMIT) }
      : {}),
  };
}

/**
 * Older checkpoint footers (`GOAL_STATUS:` for a worker, `VERDICT:` for a reviewer) are read in this one
 * place and turned into a Report, so a model that does not call the report tool still has a defined state.
 */
export function reportFromText(
  role: ReportRole,
  text: string
): ReportInput | undefined {
  if (role === "worker") {
    const status = text
      .match(/^GOAL_STATUS:\s*(continue|complete|blocked)\s*$/im)?.[1]
      ?.toLowerCase();
    if (!status) return undefined;
    const checkpoint = text.match(/^CHECKPOINT:\s*(.+)$/im)?.[1]?.trim();
    return {
      state:
        status === "complete"
          ? "ready"
          : status === "blocked"
            ? "blocked"
            : "progress",
      summary: bounded(
        checkpoint || `Worker marked the checkpoint ${status}.`,
        REPORT_SUMMARY_LIMIT
      ),
    };
  }
  const verdict = text
    .match(/^VERDICT:\s*(pass|fail|blocked)\s*$/im)?.[1]
    ?.toLowerCase();
  if (!verdict) return undefined;
  const evidence = text.match(/^EVIDENCE:\s*(.+)$/im)?.[1]?.trim();
  // A pass with no evidence is not a pass.
  if (verdict === "pass" && !evidence) {
    return {
      state: "progress",
      summary: "Reviewer passed the checkpoint without evidence.",
    };
  }
  return {
    state:
      verdict === "pass"
        ? "ready"
        : verdict === "blocked"
          ? "blocked"
          : "progress",
    summary: bounded(
      evidence || `Reviewer verdict: ${verdict}.`,
      REPORT_SUMMARY_LIMIT
    ),
  };
}

export type ReportInbox = {
  /** Keeps the executor's latest submission for a run. */
  submit(runId: string, input: ReportInput): void;
  /** Hands over and forgets the submission for a run. */
  take(runId: string): ReportInput | undefined;
};

export function createReportInbox(): ReportInbox {
  const pending = new Map<string, ReportInput>();
  return {
    submit(runId, input) {
      pending.set(runId, input);
    },
    take(runId) {
      const input = pending.get(runId);
      pending.delete(runId);
      return input;
    },
  };
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
