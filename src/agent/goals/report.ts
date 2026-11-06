import { randomUUID } from "node:crypto";
import type { CustomToolDefinition } from "../runtime/interface.ts";
import type { GoalReport, GoalReportState } from "../types.ts";

/**
 * The structured way for a Goal's worker to say where it stands, instead of Core reading a marker
 * out of free text. See docs/research/goal-report-attention-design-2026-11-06.md. The text footer
 * (`GOAL_STATUS:` ...) stays as the fallback when a model does not call the tool.
 */
export const GOAL_REPORT_TOOL_NAME = "goal_report";

/** What the model may report. `waiting` is defined (the type has it) but not offered until Phase 2 has Sources. */
const OFFERED_STATES = [
  "progress",
  "ready",
  "blocked",
  "ask",
  "dropped",
] as const;
const MAX_TEXT = 2000;
const MAX_OPTIONS = 6;

export const GOAL_REPORT_DESCRIPTION = [
  "Report where this checkpoint stands. Call it once, at the end of your work for this checkpoint.",
  "progress: what you did and what is left. ready: you believe the objective is done, with the evidence (an independent reviewer still checks it). blocked: you cannot go on without something only the person can change; say exactly what. dropped: this needs no action; say why.",
  "ask: you need the person to answer a question before you can go on (only when the task allows asking). Ask one clear question, with options when the answer is a choice. Never ask what you could find out yourself.",
].join("\n");

export type ParsedGoalReport =
  | { ok: true; report: GoalReport; note?: string }
  | { ok: false; error: string };

function text(
  value: unknown,
  field: string,
  required: boolean
): string | undefined | Error {
  if (value === undefined || value === null || value === "") {
    return required ? new Error(`${field} is required`) : undefined;
  }
  if (typeof value !== "string") return new Error(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return required ? new Error(`${field} is required`) : undefined;
  return trimmed.slice(0, MAX_TEXT);
}

/** Reads the model's arguments; an error says what is wrong so the model can correct and call again. */
export function parseGoalReport(
  params: unknown,
  options: { allowAsk: boolean; now?: () => Date }
): ParsedGoalReport {
  const input = (params && typeof params === "object" ? params : {}) as Record<
    string,
    unknown
  >;
  const state = input.state;
  if (
    typeof state !== "string" ||
    !(OFFERED_STATES as readonly string[]).includes(state)
  ) {
    return {
      ok: false,
      error: `state must be one of: ${OFFERED_STATES.join(", ")}`,
    };
  }
  const at = (options.now?.() ?? new Date()).toISOString();
  const read = (field: string, required: boolean) =>
    text(input[field], field, required);
  const fail = (e: Error): ParsedGoalReport => ({
    ok: false,
    error: e.message,
  });

  switch (state as GoalReportState) {
    case "progress": {
      const summary = read("summary", true);
      if (summary instanceof Error) return fail(summary);
      return { ok: true, report: { state: "progress", summary, at } };
    }
    case "ready": {
      const summary = read("summary", true);
      if (summary instanceof Error) return fail(summary);
      const evidence = read("evidence", true);
      if (evidence instanceof Error) return fail(evidence);
      return { ok: true, report: { state: "ready", summary, evidence, at } };
    }
    case "blocked": {
      const blocker = read("blocker", true);
      if (blocker instanceof Error) return fail(blocker);
      return { ok: true, report: { state: "blocked", blocker, at } };
    }
    case "dropped": {
      const reason = read("reason", true);
      if (reason instanceof Error) return fail(reason);
      return { ok: true, report: { state: "dropped", reason, at } };
    }
    case "ask": {
      const question = read("question", true);
      if (question instanceof Error) return fail(question);
      if (!options.allowAsk) {
        // The task did not opt in to being interrupted. Report it as a blocker so it is not lost.
        return {
          ok: true,
          report: { state: "blocked", blocker: question, at },
          note: "Asking is not enabled for this task, so this was reported as blocked with your question as the blocker.",
        };
      }
      let choices: string[] | undefined;
      if (input.options !== undefined) {
        if (
          !Array.isArray(input.options) ||
          input.options.length > MAX_OPTIONS ||
          input.options.some((o) => typeof o !== "string" || !o.trim())
        ) {
          return {
            ok: false,
            error: `options must be up to ${MAX_OPTIONS} non-empty strings`,
          };
        }
        choices = (input.options as string[]).map((o) =>
          o.trim().slice(0, 200)
        );
      }
      return {
        ok: true,
        report: {
          state: "ask",
          question,
          ...(choices?.length ? { options: choices } : {}),
          at,
        },
      };
    }
    default:
      return { ok: false, error: "unsupported state" };
  }
}

/** Per parent Goal session: whether its worker may ask, and the latest report the worker made. */
export type GoalReportInbox = {
  open(parentSessionId: string, settings: { allowAsk: boolean }): void;
  /** Returns and clears the latest report made since `open`. */
  take(parentSessionId: string): GoalReport | undefined;
  close(parentSessionId: string): void;
  /** The tool for one worker spawn, bound to its Goal; reports from it land in this inbox. */
  toolFor(parentSessionId: string): CustomToolDefinition;
};

export function createGoalReportInbox(
  now: () => Date = () => new Date()
): GoalReportInbox {
  const open = new Map<string, { allowAsk: boolean; report?: GoalReport }>();
  return {
    open(parentSessionId, settings) {
      open.set(parentSessionId, { allowAsk: settings.allowAsk });
    },
    take(parentSessionId) {
      const entry = open.get(parentSessionId);
      const report = entry?.report;
      if (entry) entry.report = undefined;
      return report;
    },
    close(parentSessionId) {
      open.delete(parentSessionId);
    },
    toolFor(parentSessionId) {
      return {
        name: GOAL_REPORT_TOOL_NAME,
        label: "Report goal progress",
        description: GOAL_REPORT_DESCRIPTION,
        parameters: {
          type: "object",
          properties: {
            state: { type: "string", enum: [...OFFERED_STATES] },
            summary: {
              type: "string",
              description: "progress, ready: what you did or finished.",
            },
            evidence: {
              type: "string",
              description:
                "ready: the command or artifact plus what you observed.",
            },
            blocker: {
              type: "string",
              description:
                "blocked: exactly what you need changed, and by whom.",
            },
            question: {
              type: "string",
              description: "ask: one clear question for the person.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              maxItems: MAX_OPTIONS,
              description: "ask: the choices, when the answer is one of a few.",
            },
            reason: {
              type: "string",
              description: "dropped: why nothing needs doing.",
            },
          },
          required: ["state"],
        },
        async execute(_toolCallId, params) {
          const entry = open.get(parentSessionId);
          if (!entry) {
            return {
              content: [
                {
                  type: "text",
                  text: "No goal is waiting for a report from this worker.",
                },
              ],
              isError: true,
            };
          }
          const parsed = parseGoalReport(params, {
            allowAsk: entry.allowAsk,
            now,
          });
          if (!parsed.ok) {
            return {
              content: [
                { type: "text", text: `Not recorded: ${parsed.error}` },
              ],
              isError: true,
            };
          }
          entry.report = parsed.report;
          return {
            content: [
              {
                type: "text",
                text: `Recorded: ${parsed.report.state}.${parsed.note ? ` ${parsed.note}` : ""}`,
              },
            ],
          };
        },
      };
    },
  };
}

/** A new id for one open question or review request. */
export const newAttentionId = (): string => randomUUID();
