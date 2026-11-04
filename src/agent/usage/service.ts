import type { Decision } from "../eval/types.ts";
import type { ActivityStore } from "../activity/store.ts";
import type { ThebeSessionStats } from "../runtime/interface.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { GoalRun } from "../types.ts";
import {
  buildUsageSummary,
  resolveUsageRange,
  type UsageQuery,
  type UsageSummary,
} from "./summary.ts";

export type UsageApi = {
  getUsageSummary(query: UsageQuery): Promise<UsageSummary>;
};

/** On-demand and read-only: it reads existing stores and keeps no state of its own. */
export function createUsageApi(deps: {
  now: () => Date;
  listMetas: () => Promise<AgentSessionMeta[]>;
  listGoals: () => Promise<GoalRun[]>;
  activityStore: Pick<ActivityStore, "list">;
  listDecisions?: () => Promise<Decision[]>;
  openSession: (thebeSessionId: string) => Promise<{
    session: {
      getContextUsage(): Promise<{ sessionStats?: ThebeSessionStats }>;
    };
  }>;
}): UsageApi {
  return {
    async getUsageSummary(query) {
      const range = resolveUsageRange(query, deps.now());
      const [metas, goals, activity, decisions] = await Promise.all([
        deps.listMetas(),
        deps.listGoals(),
        deps.activityStore.list(),
        deps.listDecisions?.() ?? [],
      ]);
      return buildUsageSummary({
        range,
        now: deps.now(),
        metas,
        goals,
        activity,
        decisions,
        async readStats(thebeSessionId) {
          try {
            const opened = await deps.openSession(thebeSessionId);
            return (await opened.session.getContextUsage()).sessionStats;
          } catch {
            return undefined;
          }
        },
      });
    },
  };
}
