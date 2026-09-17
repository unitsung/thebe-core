import { describe, expect, it } from "vitest";
import { REDACTED } from "../security/redaction.ts";
import { extractObservations } from "./observations.ts";
import type { ResourceRef } from "./types.ts";

const resource: ResourceRef = {
  kind: "container",
  id: "abc123",
  name: "emby",
  provider: "arcane",
};

describe("diagnosis observations", () => {
  it("extracts bounded facts from inspect and sampled logs without raw secrets", () => {
    const secret = "sk-live-should-never-leak";
    const result = extractObservations({
      resource,
      observedAt: "2026-09-17T00:00:00.000Z",
      inspect: {
        id: "abc123",
        name: "emby",
        image: "emby/embyserver:latest",
        state: "exited",
        config: {
          env: [`API_TOKEN=${secret}`, "NODE_ENV=production"],
          cmd: ["/init"],
          labels: { "com.docker.compose.service": "emby" },
        },
      },
      logs: [
        "starting emby",
        ...Array.from({ length: 40 }, (_, i) => `noise ${i}`),
        `fatal: token=${secret} no space left on device`,
      ].join("\n"),
      summary: {
        totalContainers: 6,
        runningContainers: 5,
        pausedContainers: 0,
        exitedContainers: 1,
        lastUpdated: 1,
      },
    });

    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.some((item) => item.kind === "state")).toBe(true);
    expect(result.observations.some((item) => /no space/i.test(item.fact))).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(REDACTED);
    expect(result.evidence.every((item) => item.excerpt.length <= 800)).toBe(true);
    expect(result.toolTranscript.map((item) => item.tool)).toEqual([
      "container.inspect",
      "container.logs",
      "container.status_summary",
    ]);
  });

  it("returns empty observations when no provider payloads exist", () => {
    const result = extractObservations({
      resource,
      observedAt: "2026-09-17T00:00:00.000Z",
    });
    expect(result.observations).toEqual([]);
    expect(result.evidence).toEqual([]);
  });
});
