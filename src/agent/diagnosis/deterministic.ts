import type {
  DiagnosisFinding,
  Observation,
  Recommendation,
  ResourceRef,
} from "./types.ts";

export function deterministicDiagnosis(input: {
  resource: ResourceRef;
  observations: Observation[];
}): { diagnosis: DiagnosisFinding; recommendations: Recommendation[] } {
  const observations = input.observations;
  if (observations.length === 0) {
    return {
      diagnosis: {
        code: "insufficient_data",
        title: "Not enough observed facts",
        summary:
          "No container facts were collected. Diagnosis cannot be invented without provider observations.",
        confidence: "low",
        reasoning:
          "The observation layer returned an empty set. The model is not allowed to fabricate facts.",
        tokenUsed: false,
      },
      recommendations: [
        {
          id: "rec-recheck-provider",
          title: "Recheck the container provider",
          detail:
            "Confirm Arcane or Portainer is reachable, then run diagnosis again.",
          kind: "read",
          requiresApproval: false,
        },
      ],
    };
  }

  const blob = observations.map((item) => item.fact.toLowerCase()).join("\n");
  const stateFact = observations.find((item) => item.kind === "state");
  const logFact = observations.find((item) => item.kind === "logs");
  const name = input.resource.name ?? input.resource.id;
  const mediaHint = isMediaServerName(name);

  if (/\bdead\b/.test(blob)) {
    return finish("container_dead", "Container is dead", `Observed state for ${name} is dead.`, "high", observations, mediaHint);
  }
  if (/\brestarting\b/.test(blob)) {
    return finish(
      "container_restarting",
      "Container is restarting",
      `Observed state for ${name} is restarting.`,
      "high",
      observations,
      mediaHint,
    );
  }
  if (/\bexited\b/.test(blob)) {
    return finish(
      "container_exited",
      "Container is not running",
      `Observed state for ${name} is exited.`,
      "high",
      observations,
      mediaHint,
    );
  }
  if (/\boom|out of memory|killed\b/.test(blob)) {
    return finish(
      "oom_killed",
      "Memory pressure in logs",
      `Logs for ${name} mention OOM or process kill.`,
      "high",
      observations,
      mediaHint,
    );
  }
  if (/no space|disk.*(full|space)/.test(blob)) {
    return finish(
      "disk_full",
      "Disk space error in logs",
      `Logs for ${name} mention disk space exhaustion.`,
      "high",
      observations,
      mediaHint,
    );
  }
  if (/\bunhealthy\b/.test(blob)) {
    return finish(
      "container_unhealthy",
      "Container is unhealthy",
      `Observed health for ${name} is unhealthy.`,
      "high",
      observations,
      mediaHint,
    );
  }
  if (/\bpaused\b/.test(blob)) {
    return finish(
      "container_paused",
      "Container is paused",
      `Observed state for ${name} is paused.`,
      "high",
      observations,
      mediaHint,
    );
  }
  if (logFact && logFact.severity === "error") {
    return finish(
      "running_with_errors",
      "Running, but logs show errors",
      `Container ${name} produced error-like log lines.`,
      "medium",
      observations,
      mediaHint,
    );
  }
  if (stateFact && /\brunning\b/.test(stateFact.fact.toLowerCase())) {
    return finish(
      "running_healthy",
      "Container appears running",
      `Observed state for ${name} is running. No high-confidence failure pattern was extracted.`,
      "medium",
      observations,
      mediaHint,
    );
  }
  return finish(
    "unknown_degraded",
    "Needs closer inspection",
    `Facts were collected for ${name}, but no single high-confidence failure code matched.`,
    "low",
    observations,
    mediaHint,
  );
}

function finish(
  code: string,
  title: string,
  summary: string,
  confidence: DiagnosisFinding["confidence"],
  observations: Observation[],
  mediaHint: boolean,
): { diagnosis: DiagnosisFinding; recommendations: Recommendation[] } {
  return {
    diagnosis: {
      code,
      title,
      summary,
      confidence,
      reasoning: `Deterministic match on observed facts: ${observations
        .slice(0, 6)
        .map((item) => item.fact)
        .join(" ")}`,
      tokenUsed: false,
    },
    recommendations: recommendationsFor(code, mediaHint),
  };
}

function recommendationsFor(code: string, mediaHint: boolean): Recommendation[] {
  const recs: Recommendation[] = [
    {
      id: "rec-review-logs",
      title: "Review recent logs on the detail page",
      detail: "Native log view stays on-device and uses no model tokens.",
      kind: "read",
      requiresApproval: false,
    },
  ];
  if (code === "container_exited" || code === "container_dead" || code === "container_unhealthy") {
    recs.push({
      id: "rec-restart",
      title: "Restart this container",
      detail:
        "Write action. Requires on-device approval. Thebe will not restart until you confirm.",
      kind: "write",
      requiresApproval: true,
      actionId: "container.restart",
    });
  }
  if (mediaHint) {
    recs.push({
      id: "rec-media-mounts",
      title: "Check media library mounts",
      detail:
        "If this container is a media server, confirm library paths and transcode temp space from the native inspect view.",
      kind: "read",
      requiresApproval: false,
    });
  }
  return recs;
}

function isMediaServerName(name: string): boolean {
  return /emby|jellyfin|plex|navidrome|immich/i.test(name);
}
