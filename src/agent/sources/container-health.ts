import type {
  ContainerHealth,
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import { key } from "../tickets/ids.ts";
import type { Source, Trigger } from "./types.ts";

/** Running containers that stop being up. */
const DOWN_STATES: ReadonlySet<ContainerState> = new Set([
  "exited",
  "dead",
  "restarting",
]);

export const CONTAINER_HEALTH_SOURCE_ID = "container-health";

/**
 * Reports a container changing state or healthcheck result. The first read only takes a baseline, so a
 * Core that starts while something is already stopped or unhealthy does not announce it as news. After
 * that each change is one Trigger, and a restart resumes from the saved baseline instead of replaying.
 *
 * Containers are named by name, not by Docker id: the id changes when a container is recreated, the name
 * is what the person calls it.
 */
export function createContainerHealthSource(options: {
  provider: ContainerInfoProvider;
  now: () => Date;
}): Source {
  return {
    id: CONTAINER_HEALTH_SOURCE_ID,
    scope: "Docker container states (read-only)",
    async read(cursor) {
      const containers = await options.provider.listContainers();
      const current: Record<string, ContainerState> = {};
      const currentHealth: Record<string, ContainerHealth> = {};
      for (const container of containers) {
        current[container.name] = container.state;
        if (container.health) currentHealth[container.name] = container.health;
      }
      const previous = parseCursor(cursor);
      if (!previous) {
        return {
          triggers: [],
          cursor: JSON.stringify({
            n: 0,
            states: current,
            health: currentHealth,
          }),
        };
      }
      // The id carries the read's sequence number. A crash before the cursor is saved re-reads the same
      // change with the same number, so the store drops the duplicate; a container that flips back and
      // forth gets a new number each time, so each flip is its own Trigger.
      const n = previous.n + 1;

      const at = options.now().toISOString();
      const triggers: Trigger[] = [];
      const names = new Set([
        ...Object.keys(previous.states),
        ...Object.keys(current),
      ]);
      for (const name of [...names].sort()) {
        const from = previous.states[name];
        const to = current[name];
        if (from !== to) {
          const kind = classify(from, to);
          triggers.push({
            id: key(
              "trigger",
              CONTAINER_HEALTH_SOURCE_ID,
              name,
              from ?? "-",
              to ?? "-",
              String(n)
            ),
            source: CONTAINER_HEALTH_SOURCE_ID,
            kind,
            at,
            threads: [`resource:container:${name}`],
            resource: { kind: "container", id: name },
            payload: { from: from ?? null, to: to ?? null },
          });
          continue;
        }
        if (!previous.tracksHealth) continue;
        const healthFrom = previous.health[name];
        const healthTo = currentHealth[name];
        const healthKind = classifyHealth(healthFrom, healthTo);
        if (!healthKind) continue;
        triggers.push({
          id: key(
            "trigger",
            CONTAINER_HEALTH_SOURCE_ID,
            name,
            "health",
            healthFrom ?? "-",
            healthTo ?? "-",
            String(n)
          ),
          source: CONTAINER_HEALTH_SOURCE_ID,
          kind: healthKind,
          at,
          threads: [`resource:container:${name}`],
          resource: { kind: "container", id: name },
          payload: {
            state: to,
            health: { from: healthFrom ?? null, to: healthTo ?? null },
          },
        });
      }
      return {
        triggers,
        cursor: JSON.stringify({
          n,
          states: current,
          health: cursorHealth(currentHealth, previous),
        }),
      };
    },
  };
}

function classify(
  from: ContainerState | undefined,
  to: ContainerState | undefined
): string {
  if (from === undefined) return "container.appeared";
  if (to === undefined) return "container.removed";
  if (from === "running" && DOWN_STATES.has(to)) return "container.went_down";
  if (DOWN_STATES.has(from) && to === "running") return "container.recovered";
  return "container.state_changed";
}

function classifyHealth(
  from: ContainerHealth | undefined,
  to: ContainerHealth | undefined
): string | undefined {
  if (to === "unhealthy" && from !== "unhealthy") return "container.unhealthy";
  if (from === "unhealthy" && to === "healthy") return "container.recovered";
  return undefined;
}

function cursorHealth(
  current: Record<string, ContainerHealth>,
  previous: {
    health: Record<string, ContainerHealth>;
    tracksHealth: boolean;
  }
): Record<string, ContainerHealth> {
  if (!previous.tracksHealth) return current;
  return Object.fromEntries(
    Object.entries(current).map(([name, health]) => [
      name,
      health === "starting" && previous.health[name] === "unhealthy"
        ? "unhealthy"
        : health,
    ])
  );
}

function parseCursor(cursor: string | undefined):
  | {
      n: number;
      states: Record<string, ContainerState>;
      health: Record<string, ContainerHealth>;
      /** Old cursor versions had no health map; seed it without announcing existing health. */
      tracksHealth: boolean;
    }
  | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as {
      n?: unknown;
      states?: unknown;
      health?: unknown;
    };
    if (
      typeof parsed.n === "number" &&
      parsed.states &&
      typeof parsed.states === "object" &&
      !Array.isArray(parsed.states)
    ) {
      const tracksHealth =
        parsed.health !== null &&
        typeof parsed.health === "object" &&
        !Array.isArray(parsed.health);
      return {
        n: parsed.n,
        states: parsed.states as Record<string, ContainerState>,
        health: tracksHealth
          ? (parsed.health as Record<string, ContainerHealth>)
          : {},
        tracksHealth,
      };
    }
  } catch {
    // An unreadable cursor is treated as no cursor: take a new baseline.
  }
  return undefined;
}
