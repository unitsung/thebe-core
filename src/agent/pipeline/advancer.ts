import type { Job, JobBook } from "./job-runner.ts";

/**
 * Keeps acquisition jobs moving while no client or model is driving them, so a
 * download-to-library run finishes under Core while the phone sleeps.
 *
 * Only jobs acquired by this Core process are tracked: a job restored from disk
 * after a restart is left for an explicit `pipeline.advance`, matching the
 * "never silently replay an interrupted write-capable run" rule. Terminal jobs
 * (done/failed) stop being tracked; failures still need an explicit retry.
 */

/** How often the background advancer checks the jobs it tracks. */
export const DEFAULT_INTERVAL_MS = 60_000;

export type PipelineAdvancer = {
  /** Track a job acquired in this process so it keeps moving without a client. */
  track(jobId: string): void;
  /** Advance every tracked, non-terminal job once. */
  runOnce(): Promise<Job[]>;
  start(): void;
  stop(): void;
  /** Number of jobs still being kept in motion. */
  size(): number;
};

export function createPipelineAdvancer(input: {
  book: JobBook;
  intervalMs: number;
  isQuiesced?: () => boolean;
  onError?: (error: unknown) => void;
}): PipelineAdvancer {
  const tracked = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function runOnce(): Promise<Job[]> {
    if (running || input.isQuiesced?.()) return [];
    running = true;
    const advanced: Job[] = [];
    try {
      for (const job of input.book.status()) {
        if (!tracked.has(job.id)) continue;
        if (job.stage === "done" || job.stage === "failed") {
          tracked.delete(job.id);
          continue;
        }
        try {
          const next = await input.book.advance(job.id);
          advanced.push(next);
          // Stop tracking as soon as the job is terminal (including a failure).
          if (next.stage === "done" || next.stage === "failed")
            tracked.delete(job.id);
        } catch (error) {
          // A provider outage must not stop the other jobs; the next tick retries.
          if (typeof input.onError === "function") input.onError(error);
          else tracked.delete(job.id);
        }
      }
    } finally {
      running = false;
    }
    return advanced;
  }

  function start(): void {
    if (timer || input.intervalMs <= 0) return;
    timer = setInterval(() => {
      void runOnce().catch(() => {});
    }, input.intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return {
    track: (jobId) => tracked.add(jobId),
    runOnce,
    start,
    stop,
    size: () => tracked.size,
  };
}

