import type { JudgmentEnabledSites, JudgmentGate } from "./types.ts";

export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";

export function readJudgmentSites(
  env: NodeJS.Dict<string> = process.env,
): JudgmentEnabledSites {
  const raw = (env.THEBE_JUDGMENT_SITES ?? "").trim().toLowerCase();
  if (!raw || raw === "*" || raw === "all") return "all";
  if (raw === "off" || raw === "none") return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readJudgmentGate(
  env: NodeJS.Dict<string> = process.env,
): JudgmentGate {
  const raw = (env.THEBE_JUDGMENT_MODEL ?? "off").trim().toLowerCase();
  if (raw !== "jev") {
    return { adapter: "off" };
  }
  const apiKey =
    env.THEBE_TYPESAFE_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    return { adapter: "off" };
  }
  return {
    adapter: "jev",
    apiKey,
    baseUrl: env.THEBE_TYPESAFE_BASE_URL?.trim() || DEFAULT_TYPESAFE_BASE_URL,
    model: env.THEBE_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL,
    sites: readJudgmentSites(env),
  };
}
