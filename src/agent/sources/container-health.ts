import type {
  ContainerInfoProvider,
  ContainerState,
} from "../capabilities/containers.ts";
import { key } from "../tickets/ids.ts";
import type { Source, Trigger } from "./types.ts";

/** Running containers that stop being up. Docker's own healthcheck is not exposed by the provider yet. */
const DOWN_STATES: ReadonlySet<ContainerState> = new Set([
  "exited",
  "dead",
  "restarting",
]);

export const CONTAINER_HEALTH_SOURCE_ID = "container-health";

/**
 * Reports a container changing state. The first read only takes a baseline, so a Core that starts while
 * something is already stopped does not announce it as news. After that each change is one Trigger, and
 * a restart of Core resumes from the saved baseline instead of replaying.
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
      for (const container of containers)
        current[container.name] = container.state;
      const previous = parseCursor(cursor);
      if (!previous) {
        return {
          triggers: [],
          cursor: JSON.stringify({ n: 0, states: current }),
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
        if (from === to) continue;
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
      }
      return { triggers, cursor: JSON.stringify({ n, states: current }) };
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

function parseCursor(
  cursor: string | undefined
): { n: number; states: Record<string, ContainerState> } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as { n?: unknown; states?: unknown };
    if (
      typeof parsed.n === "number" &&
      parsed.states &&
      typeof parsed.states === "object" &&
      !Array.isArray(parsed.states)
    ) {
      return {
        n: parsed.n,
        states: parsed.states as Record<string, ContainerState>,
      };
    }
  } catch {
    // An unreadable cursor is treated as no cursor: take a new baseline.
  }
  return undefined;
}
