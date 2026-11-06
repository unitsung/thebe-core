import { summarizeMetrics } from "../../../agent/metrics/summary.ts";
import type { AuditRecord } from "../../../agent/security/audit/audit-log.ts";
import { agentUnavailable, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { invalidBody } from "../parsing/errors.ts";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
/** Audit pages read for the gateway counts: 200 rows each, so this covers the newest 10,000 rows. */
const MAX_AUDIT_PAGES = 50;

export async function handleMetricsRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  if (context.path !== "/v1/metrics/summary") return undefined;
  if (context.request.method !== "GET") {
    return json({ ok: false, error: "method not allowed" }, 405, {
      allow: "GET",
    });
  }
  if (!context.agent) return agentUnavailable();
  const rawDays = context.url.searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (rawDays !== null) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) {
      return invalidBody(`days must be an integer from 1 to ${MAX_DAYS}`);
    }
    days = parsed;
  }
  const { agent } = context;
  const audit: AuditRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AUDIT_PAGES; page += 1) {
    const rows = await agent.listAudit({
      limit: 200,
      ...(cursor !== undefined ? { cursor: Number(cursor) } : {}),
    });
    audit.push(...rows.entries);
    if (!rows.nextCursor) break;
    cursor = rows.nextCursor;
  }
  return json(
    summarizeMetrics({
      goals: await agent.listGoals(),
      activity: await agent.listActivity(),
      audit,
      now: new Date(),
      days,
    })
  );
}
