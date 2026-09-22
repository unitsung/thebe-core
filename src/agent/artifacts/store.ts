import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { redactToolOutput } from "../security/redaction.ts";
import {
  ARTIFACT_KINDS,
  type AgentArtifact,
  type ArtifactContent,
  type ArtifactCreateInput,
  type ArtifactKind,
  type ArtifactQuery,
} from "./types.ts";

export const DEFAULT_ARTIFACT_RETENTION = 100;
export const DEFAULT_ARTIFACT_MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_ARTIFACT_LIST_LIMIT = 100;

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export type ArtifactStore = {
  create(input: ArtifactCreateInput): Promise<AgentArtifact>;
  get(artifactId: string): Promise<AgentArtifact | undefined>;
  getContent(artifactId: string): Promise<ArtifactContent | undefined>;
  list(query?: ArtifactQuery): Promise<AgentArtifact[]>;
};

export function createArtifactStore(options: {
  dir?: string;
  now: () => Date;
  maxItems?: number;
  maxContentBytes?: number;
}): ArtifactStore {
  const maxItems = options.maxItems ?? DEFAULT_ARTIFACT_RETENTION;
  const maxContentBytes =
    options.maxContentBytes ?? DEFAULT_ARTIFACT_MAX_CONTENT_BYTES;
  const memory = new Map<string, AgentArtifact>();
  const contentMemory = new Map<string, string>();
  let loaded = !options.dir;
  let loading: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (!loading) {
      loading = loadFromDisk().finally(() => {
        loaded = true;
        loading = undefined;
      });
    }
    await loading;
  }

  async function loadFromDisk(): Promise<void> {
    if (!options.dir) return;
    let names: string[] = [];
    try {
      names = (await readdir(options.dir)).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".tmp.json"),
      );
    } catch {
      return;
    }
    for (const name of names) {
      const artifact = await readArtifact(join(options.dir, name));
      if (artifact) memory.set(artifact.artifactId, artifact);
    }
    await prune();
  }

  async function persist(artifact: AgentArtifact, content: string): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const contentPath = contentFile(options.dir, artifact.artifactId);
    const metadataPath = metadataFile(options.dir, artifact.artifactId);
    const contentTemp = `${contentPath}.${process.pid}.${randomUUID()}.tmp`;
    const metadataTemp = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(contentTemp, content, "utf8");
    await rename(contentTemp, contentPath);
    await writeFile(metadataTemp, `${JSON.stringify(artifact)}\n`, "utf8");
    await rename(metadataTemp, metadataPath);
  }

  async function drop(artifactId: string): Promise<void> {
    memory.delete(artifactId);
    contentMemory.delete(artifactId);
    if (!options.dir) return;
    await Promise.all([
      unlink(metadataFile(options.dir, artifactId)).catch(() => undefined),
      unlink(contentFile(options.dir, artifactId)).catch(() => undefined),
    ]);
  }

  async function prune(): Promise<void> {
    if (memory.size <= maxItems) return;
    const extra = [...memory.values()]
      .sort((left, right) => compareTimestamp(left.createdAt, right.createdAt))
      .slice(0, memory.size - maxItems);
    for (const artifact of extra) {
      await drop(artifact.artifactId);
    }
  }

  return {
    async create(input): Promise<AgentArtifact> {
      await ensureLoaded();
      assertCreateInput(input);
      const content = redactToolOutput(input.content);
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > maxContentBytes) {
        throw new Error(`artifact content exceeds ${maxContentBytes} bytes`);
      }
      const stamp = options.now().toISOString();
      const artifact: AgentArtifact = {
        artifactId: randomUUID(),
        kind: input.kind,
        title: input.title.trim(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.resource ? { resource: { ...input.resource } } : {}),
        createdAt: stamp,
        updatedAt: stamp,
        contentType: input.contentType?.trim() || "text/plain; charset=utf-8",
        sizeBytes,
      };
      memory.set(artifact.artifactId, artifact);
      contentMemory.set(artifact.artifactId, content);
      try {
        await persist(artifact, content);
        await prune();
      } catch (error) {
        memory.delete(artifact.artifactId);
        contentMemory.delete(artifact.artifactId);
        throw error;
      }
      return cloneArtifact(artifact);
    },
    async get(artifactId): Promise<AgentArtifact | undefined> {
      assertValidArtifactId(artifactId);
      await ensureLoaded();
      const artifact = memory.get(artifactId);
      return artifact ? cloneArtifact(artifact) : undefined;
    },
    async getContent(artifactId): Promise<ArtifactContent | undefined> {
      assertValidArtifactId(artifactId);
      await ensureLoaded();
      const artifact = memory.get(artifactId);
      if (!artifact) return undefined;
      if (!options.dir) {
        const content = contentMemory.get(artifactId);
        return content === undefined
          ? undefined
          : { artifact: cloneArtifact(artifact), content };
      }
      let content: string;
      try {
        content = await readFile(contentFile(options.dir, artifactId), "utf8");
      } catch {
        return undefined;
      }
      if (Buffer.byteLength(content, "utf8") !== artifact.sizeBytes) {
        return undefined;
      }
      return { artifact: cloneArtifact(artifact), content };
    },
    async list(query = {}): Promise<AgentArtifact[]> {
      await ensureLoaded();
      const limit = normalizeLimit(query.limit);
      return [...memory.values()]
        .filter((artifact) => matches(artifact, query))
        .sort((left, right) => compareTimestamp(right.createdAt, left.createdAt))
        .slice(0, limit)
        .map(cloneArtifact);
    },
  };
}

export function assertValidArtifactId(artifactId: string): void {
  if (!ID_RE.test(artifactId)) {
    throw new Error(`invalid artifact id: ${artifactId}`);
  }
}

function assertCreateInput(input: ArtifactCreateInput): void {
  if (!ARTIFACT_KINDS.includes(input.kind)) {
    throw new Error(`invalid artifact kind: ${String(input.kind)}`);
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new Error("artifact title is required");
  }
  if (typeof input.content !== "string") {
    throw new Error("artifact content must be a string");
  }
  if (input.contentType !== undefined && !input.contentType.trim()) {
    throw new Error("artifact content type must not be empty");
  }
  if (input.sessionId !== undefined && !input.sessionId.trim()) {
    throw new Error("artifact session id must not be empty");
  }
  if (input.runId !== undefined && !input.runId.trim()) {
    throw new Error("artifact run id must not be empty");
  }
  if (
    input.resource !== undefined &&
    (!input.resource.kind.trim() || !input.resource.id.trim())
  ) {
    throw new Error("artifact resource kind and id are required");
  }
}

async function readArtifact(path: string): Promise<AgentArtifact | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.artifactId !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.contentType !== "string" ||
      typeof parsed.sizeBytes !== "number" ||
      !Number.isSafeInteger(parsed.sizeBytes) ||
      parsed.sizeBytes < 0 ||
      !ARTIFACT_KINDS.includes(parsed.kind as ArtifactKind) ||
      !ID_RE.test(parsed.artifactId)
    ) {
      return undefined;
    }
    if (
      parsed.sessionId !== undefined &&
      typeof parsed.sessionId !== "string"
    ) {
      return undefined;
    }
    if (parsed.runId !== undefined && typeof parsed.runId !== "string") {
      return undefined;
    }
    if (
      parsed.resource !== undefined &&
      (!isRecord(parsed.resource) ||
        typeof parsed.resource.kind !== "string" ||
        typeof parsed.resource.id !== "string")
    ) {
      return undefined;
    }
    return parsed as unknown as AgentArtifact;
  } catch {
    return undefined;
  }
}

function matches(artifact: AgentArtifact, query: ArtifactQuery): boolean {
  return (
    (query.kind === undefined || artifact.kind === query.kind) &&
    (query.sessionId === undefined || artifact.sessionId === query.sessionId) &&
    (query.runId === undefined || artifact.runId === query.runId) &&
    (query.createdAfter === undefined || artifact.createdAt > query.createdAfter) &&
    (query.createdBefore === undefined || artifact.createdAt < query.createdBefore)
  );
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return MAX_ARTIFACT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_ARTIFACT_LIST_LIMIT, Math.floor(value as number)));
}

function compareTimestamp(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadataFile(dir: string, artifactId: string): string {
  return join(dir, `${artifactId}.json`);
}

function contentFile(dir: string, artifactId: string): string {
  return join(dir, `${artifactId}.content`);
}

function cloneArtifact(artifact: AgentArtifact): AgentArtifact {
  return {
    ...artifact,
    ...(artifact.resource ? { resource: { ...artifact.resource } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
