import type { CustomToolDefinition } from "../runtime/interface.ts";
import {
  parseReportInput,
  REPORT_STATES,
  type ReportInbox,
} from "../reports/report.ts";

export const GOAL_REPORT_TOOL_NAME = "goal_report";

/** Profiles whose runs report to their goal through the tool. */
export const GOAL_REPORT_PROFILES: ReadonlySet<string> = new Set([
  "goal-worker",
  "goal-reviewer",
]);

export const GOAL_REPORT_TOOL_DESCRIPTION = [
  "Report where this checkpoint stands. Call it once, as your last action.",
  "state: progress (more work remains), ready (the work is done and checked; a reviewer verifies pass), waiting (you need one answer from the owner), blocked (you cannot go on), failed (it cannot be done), dropped (there was nothing to do).",
  "summary: one or two sentences of what you did or found, with the evidence.",
  "question: only with waiting or blocked. Ask exactly one concrete question; the owner is shown it as written.",
].join("\n");

export const GOAL_REPORT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    state: { type: "string", enum: [...REPORT_STATES] },
    summary: { type: "string" },
    question: { type: "string" },
  },
  required: ["state", "summary"],
} as const;

/** The report tool for one worker or reviewer run. */
export function createGoalReportTool(
  inbox: ReportInbox,
  runId: string
): CustomToolDefinition {
  return {
    name: GOAL_REPORT_TOOL_NAME,
    label: "Goal report",
    description: GOAL_REPORT_TOOL_DESCRIPTION,
    parameters: GOAL_REPORT_TOOL_SCHEMA,
    async execute(_toolCallId, input) {
      const parsed = parseReportInput(input);
      if (typeof parsed === "string") {
        return { content: [{ type: "text", text: parsed }], isError: true };
      }
      inbox.submit(runId, parsed);
      return { content: [{ type: "text", text: `Reported ${parsed.state}.` }] };
    },
  };
}
