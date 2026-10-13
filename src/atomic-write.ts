import { randomUUID } from "node:crypto";
import {
  renameSync,
  unlinkSync,
  writeFileSync,
  type WriteFileOptions,
} from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write a file atomically: write to a unique temp file in the same directory,
 * then rename it over the target. A concurrent reader sees either the previous
 * content or the complete new content, never a truncated (empty) file.
 *
 * The temp name is hidden and ends in `.tmp`, so it never matches a `*.json`
 * listing and is cleaned up if the write fails.
 */
function tempPath(target: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
  );
}

export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options?: WriteFileOptions
): Promise<void> {
  const temp = tempPath(target);
  try {
    await writeFile(temp, data, options);
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Synchronous variant for callers that cannot await. */
export function writeFileAtomicSync(
  target: string,
  data: string | Uint8Array,
  options?: WriteFileOptions
): void {
  const temp = tempPath(target);
  try {
    writeFileSync(temp, data, options);
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may not exist if the write failed early.
    }
    throw error;
  }
}
