import type { JudgmentRequest, JudgmentResult } from "./types.ts";

/** Agent-owned Judgment Model. Concrete Adapters live under src/adapters. */
export type JudgmentModel = {
  adapterId: "jev";
  judge(request: JudgmentRequest): Promise<JudgmentResult>;
};
