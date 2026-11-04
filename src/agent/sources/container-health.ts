import type {
  ContainerInfoProvider,
  ContainerSummary,
} from "../capabilities/containers.ts";
import type { Severity, Trigger } from "./types.ts";

export const CONTAINER_HEALTH_SOURCE = "container-health";

/** What a container looks like to this source. Only a change in it makes a Trigger. */
export type ContainerCondition =
  | "ok"
  | "unhealthy"
  | "restarting"
  | "down"
  | "idle";

/**
 * The saved read position: the condition last seen for each container and the source's own sequence.
 * With it a restart compares against what was already reported instead of replaying or losing changes.
 */
export type ContainerHealthCursor = {
  seq: number;
  containers: Record<string, ContainerCondition>;
};

export const EMPTY_CURSOR: ContainerHealthCursor = { seq: 0, containers: {} };

const SEVERITY_BY_KIND: Record<string, Severity> = {
  recovered: "info",
  unhealthy: "warning",
  restarting: "warning",
  down: "critical",
};

export function conditionOf(container: ContainerSummary): ContainerCondition {
  switch (container.state) {
    case "restarting":
      return "restarting";
    case "dead":
      return "down";
    case "exited":
      // A clean exit is a stop somebody asked for; a non-zero exit is a crash.
      return /Exited \((\d+)\)/i.exec(container.status)?.[1] === "0"
        ? "idle"
        : "down";
    case "running":
      return /\(unhealthy\)/i.test(container.status) ? "unhealthy" : "ok";
    case "paused":
    case "created":
      return "idle";
  }
}

/**
 * Reads the containers and returns the Triggers for what changed since `cursor`, with the next cursor.
 * A container seen for the first time raises a Trigger only if it is already in a bad condition.
 * Pure given the provider's answer; the caller decides when the new cursor is saved.
 */
export async function readContainerHealth(
  provider: Pick<ContainerInfoProvider, "listContainers">,
  cursor: ContainerHealthCursor,
  observedAt: Date
): Promise<{ triggers: Trigger[]; cursor: ContainerHealthCursor }> {
  const containers = [...(await provider.listContainers())].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const next: ContainerHealthCursor = { seq: cursor.seq, containers: {} };
  const triggers: Trigger[] = [];
  for (const container of containers) {
    const now = conditionOf(container);
    next.containers[container.id] = now;
    const kind = changeKind(cursor.containers[container.id], now);
    if (!kind) continue;
    next.seq += 1;
    const name = container.name.replace(/^\//, "");
    triggers.push({
      id: `${CONTAINER_HEALTH_SOURCE}:${container.id}:${kind}:${next.seq}`,
      source: CONTAINER_HEALTH_SOURCE,
      kind,
      severity: SEVERITY_BY_KIND[kind]!,
      thread: { kind: "container", id: container.id, name },
      summary: summaryFor(kind, name),
      observedAt: observedAt.toISOString(),
    });
  }
  return { triggers, cursor: next };
}

function changeKind(
  before: ContainerCondition | undefined,
  now: ContainerCondition
): string | undefined {
  if (before === now) return undefined;
  if (now === "unhealthy" || now === "restarting" || now === "down") return now;
  if (now === "ok" && before !== undefined && before !== "idle") {
    return "recovered";
  }
  return undefined;
}

function summaryFor(kind: string, name: string): string {
  switch (kind) {
    case "unhealthy":
      return `${name} turned unhealthy`;
    case "restarting":
      return `${name} is restarting`;
    case "down":
      return `${name} stopped unexpectedly`;
    default:
      return `${name} is healthy again`;
  }
}
