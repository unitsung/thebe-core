/**
 * A Trigger is one immutable event a Source observed: the unit of audit and of de-duplication. Its id is
 * given by the Source and is stable, so seeing the same event twice stores it once.
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
};

/**
 * A Source observes something and reports what changed since its cursor. The cursor is the Source's read
 * position, kept by the runner so a restart does not replay what was already seen.
 */
export type Source = {
  id: string;
  /** What it can see, for audit and for the settings page later; not an authorisation. */
  scope: string;
  read(cursor: string | undefined): Promise<{
    triggers: Trigger[];
    cursor: string;
  }>;
};
