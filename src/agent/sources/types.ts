/**
 * Actor identity in the Source's own vocabulary (e.g. human user or bot ID).
 */
export type ActorRef = { source: string; id: string };

/**
 * Write-only reply address on a thread (e.g. notification channel or conversation ID).
 */
export type ChannelRef = {
  /** The Source adapter that produced this address; it selects the matching ChannelAdapter. */
  source: string;
  thread: string;
  address?: Record<string, string>;
};

/** A Source's deterministic classification of an incoming message or event. */
export type SourceAdmission = "explicit" | "inferred" | "ignore";

/**
 * A Trigger is one immutable event a Source observed: the unit of audit and of de-duplication. Its id is
 * given by the Source and is stable, so seeing the same event twice stores it once. It is a 32-character
 * lower-case hexadecimal id, matching Core's durable Trigger store.
 */
export type Trigger = {
  id: string;
  /** The Source that produced it, e.g. `container-health`. */
  source: string;
  kind: string;
  at: string;
  /** Thread keys it belongs to, e.g. `resource:container:emby`. A Thread orders the Triggers about one resource. */
  threads: string[];
  resource?: { kind: string; id: string };
  payload: Record<string, unknown>;
  actor?: ActorRef;
  /** Source-declared: whether the event originated from a human rather than an automated bot/CI. */
  human?: boolean;
  /** Source-declared: how this event passed the Source's actor and addressing policy. */
  admission?: SourceAdmission;
  /** Source-declared: how the event addressed the Agent, when applicable. */
  addressed?: "mention" | "direct";
  /** Target channel to reply or send notifications back to. */
  channel?: ChannelRef;
};

/**
 * A Source observes something and reports what changed since its cursor. The cursor is the Source's read
 * position, kept by the runner so a restart does not replay what was already seen.
 */
export type Source = {
  /** A unique, non-empty id shared by this Source's Trigger, ActorRef, and ChannelRef records. */
  id: string;
  /** What it can see, for audit and for the settings page later; not an authorisation. */
  scope: string;
  /** Event kinds this Source asks Eval to weigh. Policy and the Ticket Mandate still decide what may happen. */
  assessedKinds?: readonly string[];
  /**
   * Optional deterministic source-level admission. Core persists this classification with the Trigger:
   * `explicit` goes to the Main Session, `inferred` follows Ticket/Eval routing, and `ignore` is recorded
   * without reaching either model. Sources without this hook keep the existing Eval behavior.
   */
  admit?(trigger: Trigger): SourceAdmission;
  /** AbortSignal is raised when Core quiesces during a read. */
  read(
    cursor: string | undefined,
    signal?: AbortSignal
  ): Promise<{
    triggers: Trigger[];
    cursor: string;
  }>;
};
