import type { JudgmentModel } from "./interface.ts";
import { judgmentSite, siteEnabled } from "./sites.ts";
import type {
  JudgmentEnabledSites,
  JudgmentTrace,
} from "./types.ts";

export type JudgmentApi = {
  enabled(siteId: string): boolean;
  ask(siteId: string, state: unknown): Promise<JudgmentTrace>;
};

export function createJudgmentApi(options: {
  model?: JudgmentModel;
  sites?: JudgmentEnabledSites;
}): JudgmentApi {
  const sites = options.sites ?? "all";

  function enabled(siteId: string): boolean {
    return Boolean(options.model) && siteEnabled(siteId, sites);
  }

  return {
    enabled,
    async ask(siteId, state): Promise<JudgmentTrace> {
      const site = judgmentSite(siteId);
      if (!options.model || !site || !enabled(siteId)) {
        return { siteId, used: false, path: "traditional" };
      }
      try {
        const result = await options.model.judge({
          siteId: site.id,
          questions: site.questions,
          state,
        });
        return {
          siteId: site.id,
          used: true,
          path: "judgment",
          adapter: "jev",
          answers: result.answers,
        };
      } catch (error) {
        return {
          siteId: site.id,
          used: false,
          path: "traditional",
          adapter: "jev",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
