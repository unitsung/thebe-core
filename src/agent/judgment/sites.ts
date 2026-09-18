import type { JudgmentEnabledSites, JudgmentSite } from "./types.ts";

export const DIAGNOSIS_WRITE_RECOMMENDATION_SITE = "diagnosis.write_recommendation";

/** Catalog of named judgment places. Any caller may `ask(id)` when the Gate allows that Site. */
export const JUDGMENT_SITES: readonly JudgmentSite[] = [
  {
    id: DIAGNOSIS_WRITE_RECOMMENDATION_SITE,
    traditionalPath: "deterministic_then_chat",
    questions: {
      restart_supported: {
        type: "noul",
        instructions:
          "Do the observed facts support recommending a container restart as a write that still requires on-device approval?",
        criteria: {
          true: "Restart is a reasonable next write given exited, dead, unhealthy, or equivalent observed failure.",
          false: "Facts do not support a restart recommendation; keep read-only next steps.",
        },
      },
    },
  },
  {
    id: "diagnosis.severity",
    traditionalPath: "deterministic_then_chat",
    questions: {
      severity: {
        type: "score",
        instructions: "How severe is this container incident?",
        criteria: ["cosmetic", "degraded", "blocking"],
      },
    },
  },
  {
    id: "intent.capability",
    traditionalPath: "chat_model",
    questions: {
      capability: {
        type: "choice",
        instructions: "Which homelab capability matches this user intent?",
        criteria: {
          "container.inspect": "Inspect one container",
          "container.restart": "Restart one container after approval",
          none: "No matching capability",
        },
      },
    },
  },
  {
    id: "home.attention",
    traditionalPath: "deterministic",
    questions: {
      urgent: {
        type: "noul",
        instructions: "Does this now-health observation need user attention now?",
      },
    },
  },
  {
    id: "agent.tool_result_sufficient",
    traditionalPath: "chat_model",
    questions: {
      sufficient: {
        type: "noul",
        instructions: "Is this tool result enough to continue without another tool call?",
      },
    },
  },
  {
    id: "activity.notify",
    traditionalPath: "deterministic",
    questions: {
      notify: {
        type: "noul",
        instructions: "Should this Activity item disturb the user now?",
      },
    },
  },
];

export function judgmentSite(id: string): JudgmentSite | undefined {
  return JUDGMENT_SITES.find((site) => site.id === id);
}

export function siteEnabled(
  siteId: string,
  enabled: JudgmentEnabledSites,
): boolean {
  if (enabled === "all") return Boolean(judgmentSite(siteId));
  return enabled.includes(siteId) && Boolean(judgmentSite(siteId));
}
