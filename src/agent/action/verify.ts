import type { ContainerDetail, ContainerInfoProvider } from "../capabilities/containers.ts";
import type { ResourceRef } from "../diagnosis/types.ts";
import type { VerificationCheck, VerificationResult } from "./types.ts";

const EMBY_PATHS = [
  "/emby/System/Info/Public",
  "/System/Info/Public",
];

export type ProbeHealth = (url: string) => Promise<{ ok: boolean; status?: number }>;

export async function verifyRestart(input: {
  provider: ContainerInfoProvider;
  resource: ResourceRef;
  now: () => Date;
  probe?: ProbeHealth;
}): Promise<VerificationResult> {
  const observedAt = input.now().toISOString();
  let detail: ContainerDetail;
  try {
    detail = await input.provider.inspectContainer(input.resource.id);
  } catch {
    return {
      status: "unavailable",
      checks: [
        {
          id: "container.state",
          ok: false,
          expected: "running",
          actual: "unavailable",
          source: "container.inspect",
          observedAt,
        },
      ],
    };
  }

  const state = (detail.state ?? "").toLowerCase();
  const running = state === "running";
  const checks: VerificationCheck[] = [
    {
      id: "container.state",
      ok: running,
      expected: "running",
      actual: detail.state,
      source: "container.inspect",
      observedAt,
    },
  ];

  const emby = isEmby(input.resource, detail);
  if (emby) {
    const health = await verifyEmbyHealth({
      detail,
      observedAt,
      probe: input.probe,
    });
    checks.push(health);
  }

  const failed = checks.some((item) => !item.ok && !item.skipped);
  const skippedOnly = checks.every((item) => item.ok || item.skipped);
  return {
    status: failed ? "failed" : skippedOnly && !running ? "failed" : running ? "passed" : "failed",
    checks,
  };
}

export function isEmby(resource: ResourceRef, detail: ContainerDetail): boolean {
  const blob = [
    resource.name,
    detail.name,
    detail.image,
    ...(Object.values(detail.config.labels ?? {})),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\bemby\b/.test(blob);
}

async function verifyEmbyHealth(input: {
  detail: ContainerDetail;
  observedAt: string;
  probe?: ProbeHealth;
}): Promise<VerificationCheck> {
  if (!input.probe) {
    return {
      id: "emby.health",
      ok: true,
      expected: "reachable",
      actual: "skipped",
      source: "emby.public_info",
      observedAt: input.observedAt,
      skipped: true,
    };
  }
  const urls = embyUrls(input.detail);
  if (urls.length === 0) {
    return {
      id: "emby.health",
      ok: true,
      expected: "reachable",
      actual: "no published endpoint",
      source: "emby.public_info",
      observedAt: input.observedAt,
      skipped: true,
    };
  }
  for (const url of urls) {
    try {
      const result = await input.probe(url);
      if (result.ok) {
        return {
          id: "emby.health",
          ok: true,
          expected: "reachable",
          actual: `HTTP ${result.status ?? 200}`,
          source: "emby.public_info",
          observedAt: input.observedAt,
        };
      }
    } catch {
      // try next candidate
    }
  }
  return {
    id: "emby.health",
    ok: false,
    expected: "reachable",
    actual: "unreachable",
    source: "emby.public_info",
    observedAt: input.observedAt,
  };
}

function embyUrls(detail: ContainerDetail): string[] {
  const ports = detail.networkSettings?.ports ?? {};
  const urls: string[] = [];
  for (const [containerPort, hosts] of Object.entries(ports)) {
    if (!/8096/.test(containerPort) && !/443/.test(containerPort)) continue;
    for (const host of hosts ?? []) {
      const ip = !host.HostIp || host.HostIp === "0.0.0.0" || host.HostIp === "::" ? "127.0.0.1" : host.HostIp;
      const port = host.HostPort;
      if (!port) continue;
      const scheme = /443/.test(containerPort) ? "https" : "http";
      for (const path of EMBY_PATHS) {
        urls.push(`${scheme}://${ip}:${port}${path}`);
      }
    }
  }
  return urls.slice(0, 6);
}
