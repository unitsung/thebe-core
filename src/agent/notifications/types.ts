import type { QuietHours } from "./quiet-hours.ts";
import type { ChannelRef } from "../sources/types.ts";

/** What a notice is about. The App and the router use the same values. */
export const NOTICE_CATEGORIES = [
  "attention",
  "completed",
  "failed",
  "budget",
  "watchdog",
  "source_health",
  "pipeline",
] as const;

export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export const NOTICE_PRIORITIES = ["critical", "normal", "low"] as const;

export type NoticePriority = (typeof NOTICE_PRIORITIES)[number];

/**
 * One person-facing event. `id` is the stable deduplication key: the same business event delivered again
 * is the same notice, even after a restart. Bodies are written by the caller and never by a model on the
 * delivery path; they must not contain filenames, logs, or credentials.
 */
export type Notification = {
  id: string;
  category: NoticeCategory;
  priority: NoticePriority;
  title: string;
  body: string;
  /** `thebe://...` route the App opens when the notice is tapped. */
  deepLink?: string;
  ticketId?: string;
  goalId?: string;
  /** For a Ticket notice, the exact reason so a write-back adapter preserves it. */
  ticketReason?: "answer" | "review" | "blocked" | "stalled";
  resource?: { kind: string; id: string };
  /** ISO timestamp. Set once when the business event happens. */
  createdAt: string;
};

/**
 * A configured destination. `id` is stable across edits so the outbox queue and status survive a settings
 * change. Credentials are not stored here; adapters read them from the environment or their own store.
 */
export type NotificationTarget = {
  id: string;
  /** Short name for the settings page. */
  label?: string;
  channel: ChannelRef;
  categories: NoticeCategory[] | "all";
  /** `low` by default: a target accepts every priority unless it narrows itself. */
  minPriority?: NoticePriority;
  quietHours?: QuietHours;
  /** Reserved for the digest phase: low/normal notices accumulate for this window. */
  digest?: { windowMinutes: number; categories: NoticeCategory[] };
  enabled: boolean;
};

export type NotificationSettings = {
  version: 1;
  targets: NotificationTarget[];
  defaultQuietHours?: QuietHours;
  /** A critical notice ignores quiet hours unless this is false. */
  criticalBypassesQuietHours: boolean;
  /** Per target, per hour. Zero disables the limit. Critical notices are never rate limited. */
  rateLimitPerHour: number;
  updatedAt: string;
};

/** The outcome of one adapter call. `unknown` means the request may have reached the platform. */
export type NotificationDeliveryAttempt =
  | { status: "sent" }
  | { status: "discard"; reason: string }
  | { status: "retry"; reason: string; retryAfterMs?: number }
  | { status: "unknown"; reason: string };

export type NotificationSendInput = {
  target: NotificationTarget;
  notification: Notification;
  /** Stable for retries of the same notice to the same target. */
  idempotencyKey: string;
};

/** An adapter's honest limits, so a future router can format or choose a channel without guessing. */
export type NotificationCapabilities = {
  /** Can send without a preceding inbound message. */
  proactive: boolean;
  /** Understands the Markdown Core sends; when false Core must send plain text. */
  markdown: boolean;
  /** Characters accepted in one message; adapters still truncate defensively. */
  maxTextLength?: number;
  media?: boolean;
};

/** A host supplied, vendor-neutral notification transport. */
export type NotificationAdapter = {
  /** Must match `ChannelRef.source`. */
  id: string;
  capabilities?: NotificationCapabilities;
  /** Confirms this adapter can deliver to this specific address. */
  accepts(channel: ChannelRef): boolean | Promise<boolean>;
  send(input: NotificationSendInput): Promise<NotificationDeliveryAttempt>;
};

export type NotificationOutboxStatus = {
  pending: number;
  dropped: number;
  unknown: number;
  lastSentAt?: string;
  lastError?: string;
  lastFailureAt?: string;
  lastDrop?: { id: string; reason: string; at: string };
};

export type NotificationTargetStatus = NotificationOutboxStatus & {
  targetId: string;
  label?: string;
  enabled: boolean;
  /** Notices held in the target's digest window, not yet queued. */
  digestPending?: number;
  lastSentAt?: string;
};

export type NotificationStatus = {
  pending: number;
  dropped: number;
  unknown: number;
  lastError?: string;
  lastFailureAt?: string;
  targets: NotificationTargetStatus[];
};

export function noticePriorityRank(priority: NoticePriority): number {
  switch (priority) {
    case "critical":
      return 2;
    case "normal":
      return 1;
    case "low":
      return 0;
  }
}

export function isNoticeCategory(value: unknown): value is NoticeCategory {
  return (
    typeof value === "string" &&
    (NOTICE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isNoticePriority(value: unknown): value is NoticePriority {
  return (
    typeof value === "string" &&
    (NOTICE_PRIORITIES as readonly string[]).includes(value)
  );
}

export function priorityForGoalNotice(
  type: "goal_needs_person" | "goal_completed",
  reason?: "answer" | "review" | "blocked" | "stalled"
): NoticePriority {
  if (type === "goal_completed") return "normal";
  // A person is the only unblock: every needs-person state is critical. `answer` is included because
  // the worker cannot continue without the answer, while `review` can wait briefly but must not be lost.
  return reason === "review" ? "normal" : "critical";
}
