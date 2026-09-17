import { REDACTED, redactToolOutput } from "../security/redaction.ts";
import type { ContainerDetail, HostStatusSummary } from "../capabilities/containers.ts";
import type {
  Observation,
  ResourceRef,
  TechnicalEvidence,
  ToolTranscriptEntry,
} from "./types.ts";

export const MAX_OBSERVATIONS = 24;
export const MAX_LOG_SAMPLE_LINES = 20;
export const MAX_EVIDENCE_CHARS = 800;
export const MAX_LOG_FACT_CHARS = 1200;
export const DIAGNOSIS_LOG_TAIL = 80;

const SECRET_MARKERS = [REDACTED, "sk-", "password=", "token="];

export function unwrapToolOutput(raw: string): string {
  const match = raw.match(/<tool_output tool="[^"]*">\n?([\s\S]*?)\n?<\/tool_output>/);
  return match?.[1]?.trim() ?? raw.trim();
}

export function parseToolPayload(raw: string): unknown {
  const unwrapped = unwrapToolOutput(raw);
  try {
    return JSON.parse(unwrapped) as unknown;
  } catch {
    return unwrapped;
  }
}

export function asContainerDetail(value: unknown): ContainerDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string") return undefined;
  return value as ContainerDetail;
}

export function asHostSummary(value: unknown): HostStatusSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.totalContainers !== "number") return undefined;
  return value as HostStatusSummary;
}

export function asLogText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

export function extractObservations(input: {
  resource: ResourceRef;
  observedAt: string;
  inspect?: ContainerDetail;
  logs?: string;
  summary?: HostStatusSummary;
  inspectError?: string;
  logsError?: string;
  summaryError?: string;
}): {
  observations: Observation[];
  evidence: TechnicalEvidence[];
  toolTranscript: ToolTranscriptEntry[];
} {
  const observations: Observation[] = [];
  const evidence: TechnicalEvidence[] = [];
  const toolTranscript: ToolTranscriptEntry[] = [];
  const resource = {
    kind: input.resource.kind,
    id: input.resource.id,
    provider: input.resource.provider,
  };
  let nextId = 1;
  const push = (observation: Omit<Observation, "id">) => {
    if (observations.length >= MAX_OBSERVATIONS) return;
    observations.push({ id: `obs-${nextId++}`, ...observation });
  };

  if (input.inspectError) {
    toolTranscript.push({
      tool: "container.inspect",
      summary: clip(`failed: ${input.inspectError}`, 240),
      observedAt: input.observedAt,
    });
    push({
      kind: "error",
      fact: clip(`container.inspect failed: ${input.inspectError}`, 280),
      source: "container.inspect",
      observedAt: input.observedAt,
      resource,
      severity: "error",
    });
  } else if (input.inspect) {
    const detail = input.inspect;
    toolTranscript.push({
      tool: "container.inspect",
      summary: `${detail.name} state=${detail.state} image=${detail.image}`,
      observedAt: input.observedAt,
    });
    push({
      kind: "state",
      fact: `Container ${detail.name} is ${detail.state}.`,
      source: "container.inspect",
      observedAt: input.observedAt,
      resource,
      severity: stateSeverity(detail.state),
    });
    if (detail.image) {
      push({
        kind: "image",
        fact: `Image is ${detail.image}.`,
        source: "container.inspect",
        observedAt: input.observedAt,
        resource,
        severity: "info",
      });
    }
    const health = healthFromDetail(detail);
    if (health) {
      push({
        kind: "health",
        fact: health.fact,
        source: "container.inspect",
        observedAt: input.observedAt,
        resource,
        severity: health.severity,
      });
    }
    const cmd = detail.config.cmd?.filter(Boolean).slice(0, 8).join(" ");
    if (cmd) {
      push({
        kind: "config",
        fact: `Command: ${clip(cmd, 200)}.`,
        source: "container.inspect",
        observedAt: input.observedAt,
        resource,
        severity: "info",
      });
    }
    const env = detail.config.env ?? [];
    const redactedCount = env.filter((line) => line.includes(REDACTED)).length;
    if (env.length > 0) {
      push({
        kind: "config",
        fact: `Environment has ${env.length} entries; ${redactedCount} secret values redacted.`,
        source: "container.inspect",
        observedAt: input.observedAt,
        resource,
        severity: "info",
      });
    }
    const ports = summarizePorts(detail);
    if (ports) {
      push({
        kind: "network",
        fact: ports,
        source: "container.inspect",
        observedAt: input.observedAt,
        resource,
        severity: "info",
      });
    }
    evidence.push({
      source: "container.inspect",
      excerpt: clip(inspectExcerpt(detail), MAX_EVIDENCE_CHARS),
      observedAt: input.observedAt,
    });
  }

  if (input.logsError) {
    toolTranscript.push({
      tool: "container.logs",
      summary: clip(`failed: ${input.logsError}`, 240),
      observedAt: input.observedAt,
    });
    push({
      kind: "error",
      fact: clip(`container.logs failed: ${input.logsError}`, 280),
      source: "container.logs",
      observedAt: input.observedAt,
      resource,
      severity: "warning",
    });
  } else if (input.logs !== undefined) {
    const sampled = sampleLogLines(input.logs);
    toolTranscript.push({
      tool: "container.logs",
      summary: sampled.summary,
      observedAt: input.observedAt,
    });
    if (sampled.fact) {
      push({
        kind: "logs",
        fact: sampled.fact,
        source: "container.logs",
        observedAt: input.observedAt,
        resource,
        severity: sampled.severity,
      });
    }
    if (sampled.excerpt) {
      evidence.push({
        source: "container.logs",
        excerpt: clip(sampled.excerpt, MAX_EVIDENCE_CHARS),
        observedAt: input.observedAt,
      });
    }
  }

  if (input.summaryError) {
    toolTranscript.push({
      tool: "container.status_summary",
      summary: clip(`failed: ${input.summaryError}`, 240),
      observedAt: input.observedAt,
    });
  } else if (input.summary) {
    const summary = input.summary;
    toolTranscript.push({
      tool: "container.status_summary",
      summary: `${summary.runningContainers}/${summary.totalContainers} running`,
      observedAt: input.observedAt,
    });
    push({
      kind: "host",
      fact: `Host has ${summary.totalContainers} containers (${summary.runningContainers} running, ${summary.exitedContainers} exited, ${summary.pausedContainers} paused).`,
      source: "container.status_summary",
      observedAt: input.observedAt,
      resource,
      severity: "info",
    });
  }

  return { observations, evidence, toolTranscript };
}

export function assertNoSecrets(text: string): boolean {
  const lower = text.toLowerCase();
  return !SECRET_MARKERS.some((marker) => {
    if (marker === REDACTED) return false;
    return lower.includes(marker.toLowerCase());
  });
}

function stateSeverity(state: string): Observation["severity"] {
  const value = state.toLowerCase();
  if (value === "exited" || value === "dead") return "error";
  if (value === "restarting" || value === "paused") return "warning";
  return "info";
}

function healthFromDetail(detail: ContainerDetail): {
  fact: string;
  severity: Observation["severity"];
} | undefined {
  const labels = detail.config.labels ?? {};
  const healthLabel =
    labels["health"] ??
    labels["com.docker.compose.service"] ??
    undefined;
  const state = detail.state.toLowerCase();
  if (state.includes("unhealthy")) {
    return {
      fact: "Reported state includes unhealthy.",
      severity: "error",
    };
  }
  if (healthLabel && /unhealthy/i.test(healthLabel)) {
    return {
      fact: "Health label reports unhealthy.",
      severity: "error",
    };
  }
  return undefined;
}

function summarizePorts(detail: ContainerDetail): string | undefined {
  const ports = detail.networkSettings?.ports;
  if (!ports) return undefined;
  const mappings: string[] = [];
  for (const [containerPort, hosts] of Object.entries(ports)) {
    if (!hosts?.length) continue;
    const host = hosts[0];
    if (!host) continue;
    mappings.push(`${host.HostPort}->${containerPort}`);
    if (mappings.length >= 6) break;
  }
  if (mappings.length === 0) return undefined;
  return `Published ports: ${mappings.join(", ")}.`;
}

function inspectExcerpt(detail: ContainerDetail): string {
  const envKeys = (detail.config.env ?? []).map((line) => line.split("=")[0] ?? line);
  return JSON.stringify({
    id: detail.id,
    name: detail.name,
    image: detail.image,
    state: detail.state,
    cmd: detail.config.cmd?.slice(0, 8),
    envKeys: envKeys.slice(0, 20),
    labels: pickSafeLabels(detail.config.labels),
  });
}

function pickSafeLabels(labels?: Record<string, string>): Record<string, string> {
  if (!labels) return {};
  const keep = [
    "com.docker.compose.project",
    "com.docker.compose.service",
    "com.docker.compose.container-number",
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    if (labels[key]) out[key] = labels[key];
  }
  return out;
}

function sampleLogLines(raw: string): {
  fact: string;
  excerpt: string;
  summary: string;
  severity: Observation["severity"];
} {
  const redacted = redactToolOutput(raw);
  const lines = redacted
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && line !== "[... truncated ...]");
  const interesting = lines.filter((line) =>
    /error|fatal|panic|oom|killed|unhealthy|econnrefused|no space|permission denied|traceback/i.test(
      line,
    ),
  );
  const sampled = (interesting.length > 0 ? interesting : lines).slice(-MAX_LOG_SAMPLE_LINES);
  const excerpt = sampled.join("\n");
  const severity = interesting.length > 0 ? "error" : "info";
  const fact =
    sampled.length === 0
      ? "No recent log lines were available."
      : interesting.length > 0
        ? clip(
            `Recent logs contain ${interesting.length} error-like lines. Last: ${sampled[sampled.length - 1]}`,
            MAX_LOG_FACT_CHARS,
          )
        : clip(
            `Recent logs (${sampled.length} sampled lines) show no error pattern. Last: ${sampled[sampled.length - 1]}`,
            MAX_LOG_FACT_CHARS,
          );
  return {
    fact,
    excerpt,
    summary: `${lines.length} lines, ${sampled.length} sampled, ${interesting.length} error-like`,
    severity,
  };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
