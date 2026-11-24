import type { ContainerHealth } from "../agent/capabilities/containers.ts";

const HEALTH_STATES = new Set<ContainerHealth>([
  "starting",
  "healthy",
  "unhealthy",
]);

/**
 * Docker 29 adds a Health field to the list response. Older engines and Arcane
 * expose the same state in Status text, so accept both shapes.
 */
export function mapDockerHealth(
  raw: unknown,
  status = ""
): ContainerHealth | undefined {
  const direct =
    typeof raw === "string"
      ? normalize(raw)
      : raw && typeof raw === "object" && !Array.isArray(raw)
        ? normalize(
            (raw as Record<string, unknown>).Status ??
              (raw as Record<string, unknown>).status
          )
        : undefined;
  if (direct) return direct;

  const match = status.match(
    /(?:\bhealth\s*:\s*)?\b(starting|healthy|unhealthy)\b/i
  );
  return match ? normalize(match[1]) : undefined;
}

function normalize(value: unknown): ContainerHealth | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  return HEALTH_STATES.has(lower as ContainerHealth)
    ? (lower as ContainerHealth)
    : undefined;
}
