import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ProductSessionMeta = {
  thebeSessionId: string;
  runtimeId: string;
  runtimeSessionId: string;
  selectedContext?: {
    host?: string;
    environment?: string;
    service?: string;
  };
  labels?: Record<string, string>;
  shareMetadata?: Record<string, unknown>;
};

const FORBIDDEN_KEYS = [
  "transcript",
  "messages",
  "compaction",
  "refresh_token",
  "refreshToken",
  "oauth",
  "branch",
  "branches",
] as const;

export function assertMetadataOnly(record: Record<string, unknown>): void {
  for (const key of FORBIDDEN_KEYS) {
    if (key in record) {
      throw new Error(`ProductStore forbids persistence key: ${key}`);
    }
  }
}

export function createProductStore(dir?: string) {
  async function save(meta: ProductSessionMeta): Promise<void> {
    assertMetadataOnly(meta as unknown as Record<string, unknown>);
    if (!dir) {
      return;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${meta.thebeSessionId}.json`),
      JSON.stringify(meta),
      "utf8",
    );
  }

  async function load(thebeSessionId: string): Promise<ProductSessionMeta> {
    if (!dir) {
      throw new Error("ProductStore has no directory");
    }
    const text = await readFile(join(dir, `${thebeSessionId}.json`), "utf8");
    const parsed = JSON.parse(text) as ProductSessionMeta;
    assertMetadataOnly(parsed as unknown as Record<string, unknown>);
    return parsed;
  }

  async function list(): Promise<ProductSessionMeta[]> {
    if (!dir) {
      return [];
    }
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const rows: ProductSessionMeta[] = [];
    for (const name of names.sort()) {
      rows.push(await load(name.replace(/\.json$/, "")));
    }
    return rows;
  }

  return { save, load, list };
}
