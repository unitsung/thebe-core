import type { MediaLibraryProvider } from "../capabilities/media.ts";
import type { DownloadProvider } from "../capabilities/pipeline.ts";
import type { DiagnosisApi, DiagnosisPreview } from "../diagnosis/service.ts";
import type { Trigger } from "../sources/types.ts";
import type { SpeculativePreparation } from "./types.ts";

type Observation = SpeculativePreparation["observations"][number];

export type EvalMediaLibraryDependency = {
  service: "emby" | "jellyfin";
  provider: MediaLibraryProvider;
};

export type EvalPreparationDependencies = {
  diagnosis: Pick<DiagnosisApi, "preview">;
  now: () => Date;
  downloads?: DownloadProvider;
  mediaLibraries?: readonly EvalMediaLibraryDependency[];
};

/**
 * Gather bounded, read-only evidence before Eval asks its model. No provider write is reachable from here;
 * failures become absent evidence so the Assessment still runs from the Trigger itself.
 */
export async function prepareForEval(
  triggers: readonly Trigger[],
  dependencies: EvalPreparationDependencies
): Promise<SpeculativePreparation | undefined> {
  for (let index = triggers.length - 1; index >= 0; index -= 1) {
    const trigger = triggers[index]!;
    if (
      trigger.kind === "container.went_down" &&
      trigger.resource?.kind === "container"
    ) {
      const preview = await dependencies.diagnosis.preview({
        resource: {
          kind: "container",
          id: trigger.resource.id,
          provider: "unknown",
        },
      });
      return containerPreparation(preview);
    }
    if (trigger.kind === "download.completed") {
      return downloadPreparation(trigger, dependencies);
    }
  }
  return undefined;
}

function containerPreparation(
  preview: DiagnosisPreview
): SpeculativePreparation {
  return {
    source: "container-diagnosis",
    observedAt: preview.observedAt,
    resource: {
      kind: preview.resource.kind,
      id: preview.resource.id,
    },
    diagnosis: {
      code: preview.diagnosis.code.slice(0, 120),
      title: preview.diagnosis.title.slice(0, 200),
      summary: preview.diagnosis.summary.slice(0, 600),
      confidence: preview.diagnosis.confidence,
    },
    observations: preview.observations.slice(0, 8).map((observation) => ({
      kind: observation.kind,
      severity: observation.severity,
      fact: observation.fact.slice(0, 600),
    })),
    suggestions: preview.recommendations.slice(0, 4).map((recommendation) => ({
      title: recommendation.title.slice(0, 200),
      detail: recommendation.detail.slice(0, 300),
      kind: recommendation.kind,
      requiresApproval: recommendation.requiresApproval,
    })),
  };
}

async function downloadPreparation(
  trigger: Trigger,
  dependencies: EvalPreparationDependencies
): Promise<SpeculativePreparation> {
  const observations: Observation[] = [];
  const name =
    stringValue(trigger.payload.name) ??
    stringValue(trigger.payload.hash) ??
    trigger.resource?.id ??
    "download";
  const contentPath = stringValue(trigger.payload.contentPath);
  const sizeBytes = numberValue(trigger.payload.sizeBytes);
  observations.push({
    kind: "download",
    severity: "info",
    fact: `Download ${clip(name, 240)} reached completed.`,
  });
  if (contentPath) {
    observations.push({
      kind: "path",
      severity: "info",
      fact: `Downloader content path: ${clip(contentPath, 400)}.`,
    });
  }
  if (sizeBytes !== undefined) {
    observations.push({
      kind: "size",
      severity: "info",
      fact: `Downloaded size: ${Math.max(0, Math.floor(sizeBytes))} bytes.`,
    });
  }

  const hash = stringValue(trigger.payload.hash);
  if (hash && dependencies.downloads) {
    try {
      const current = await dependencies.downloads.get(hash);
      if (current) {
        observations.push({
          kind: "download",
          severity: current.phase === "completed" ? "info" : "warning",
          fact: [
            `Current downloader state is ${clip(current.phase, 80)}`,
            `${Math.round(Math.max(0, Math.min(1, current.progress)) * 100)}%`,
            ...(current.name ? [`name ${clip(current.name, 240)}`] : []),
            ...(current.contentPath
              ? [`path ${clip(current.contentPath, 300)}`]
              : []),
          ].join(", "),
        });
      } else {
        observations.push({
          kind: "download",
          severity: "warning",
          fact: "The downloader no longer lists this completed item.",
        });
      }
    } catch {
      observations.push({
        kind: "download",
        severity: "warning",
        fact: "The current downloader state could not be read.",
      });
    }
  }

  const query = searchableTitle(name);
  const libraries = dependencies.mediaLibraries ?? [];
  if (query && libraries.length > 0) {
    const searches = await Promise.all(
      libraries.map(async (library) => {
        try {
          const page = await library.provider.searchItems({
            query,
            limit: 5,
          });
          return { service: library.service, page };
        } catch {
          return { service: library.service, page: undefined };
        }
      })
    );
    for (const result of searches) {
      if (!result.page) {
        observations.push({
          kind: "library",
          severity: "warning",
          fact: `${capitalize(result.service)} library search could not be read.`,
        });
        continue;
      }
      const items = result.page.items
        .slice(0, 5)
        .map((item) =>
          item.year === undefined
            ? clip(item.title, 160)
            : `${clip(item.title, 160)} (${item.year})`
        );
      observations.push({
        kind: "library",
        severity: "info",
        fact: `${capitalize(result.service)} search for ${JSON.stringify(query)} returned ${result.page.total ?? result.page.items.length} item(s)${items.length > 0 ? `: ${items.join("; ")}` : "."}`,
      });
    }
  }

  return {
    source: "download-completed",
    observedAt: dependencies.now().toISOString(),
    ...(trigger.resource
      ? {
          resource: {
            kind: trigger.resource.kind,
            id: trigger.resource.id,
          },
        }
      : {}),
    observations: observations.slice(0, 8),
    suggestions:
      query && libraries.length > 0
        ? [
            {
              title:
                "Check whether the completed item is already in the library",
              detail:
                "Read-only library search results are included above; any import or scan remains a separately authorised write.",
              kind: "read",
              requiresApproval: false,
            },
          ]
        : [],
  };
}

export function searchableTitle(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]{2,5}$/u, "")
    .replace(/[._]+/gu, " ")
    .replace(
      /\b(?:2160p|1080p|720p|480p|WEB[- ]?DL|WEBRip|BluRay|BRRip|HDTV|x264|x265|H\.?264|H\.?265)\b.*$/iu,
      ""
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
