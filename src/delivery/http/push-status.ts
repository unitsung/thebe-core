/** What the push outbox reports; `/v1/health` shows it under `push`. */
export type PushOutboxStatus = {
  /** Notices waiting for the relay, across all devices. */
  pending: number;
  /** Failed attempts in a row since the relay last answered. */
  consecutiveFailures: number;
  /** Notices given up on (permanent refusal, or three transient failures), among those remembered. */
  dropped: number;
  lastError?: string;
  lastFailureAt?: string;
  lastDrop?: { id: string; reason: string; at: string };
};
