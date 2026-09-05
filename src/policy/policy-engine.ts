import { CONTAINER_TOOL_NAMES } from "../tools/container-tools.ts";

const LOGS_DAILY_LIMIT = 1000;

export function createPolicyEngine(options: { now: () => Date }) {
  const logsByDayAndCaller = new Map<string, number>();

  return {
    allow(
      name: string,
      callerId: string,
    ): { ok: true; budgetConsumed: number } | { ok: false; reason: string } {
      if (
        !(CONTAINER_TOOL_NAMES as readonly string[]).includes(name)
      ) {
        return { ok: false, reason: `unknown tool: ${name}` };
      }
      if (name !== "container.logs") {
        return { ok: true, budgetConsumed: 0 };
      }
      const day = options.now().toISOString().slice(0, 10);
      const key = `${day}:${callerId}`;
      const used = logsByDayAndCaller.get(key) ?? 0;
      if (used >= LOGS_DAILY_LIMIT) {
        return { ok: false, reason: "container.logs daily budget exceeded" };
      }
      logsByDayAndCaller.set(key, used + 1);
      return { ok: true, budgetConsumed: 1 };
    },
  };
}
