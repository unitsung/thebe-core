import type { RuntimeModelRef } from "../runtime/interface.ts";

/** What Thebe may do on its own when an event arrives. Observe is the default. */
export const ACCEPT_MODES = ["off", "observe", "auto"] as const;
export type AcceptMode = (typeof ACCEPT_MODES)[number];

/** One rule in plain language: a name and a paragraph. Never parsed, only read by the Assessment. */
export type PolicyRule = { id: string; name: string; text: string };

/** A built-in group of rules for a common homelab situation, switched on or off as one. */
export type PolicyDefaultSet = {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  rules: PolicyRule[];
};

/**
 * Settings for one event source. `enabled` is the only key Core reads here; the source decides the
 * rest (severity, quiet hours, an allowed list of containers).
 */
export type PolicySourceSettings = { enabled: boolean } & Record<
  string,
  unknown
>;

/**
 * One immutable version of the policy. A mandate or decision records `version`; the default rules
 * are stored resolved so a later change to the built-in text never rewrites history.
 */
export type PolicyVersion = {
  version: number;
  createdAt: string;
  mode: AcceptMode;
  rules: PolicyRule[];
  defaultSets: PolicyDefaultSet[];
  sources: Record<string, PolicySourceSettings>;
  /**
   * The cheaper model for background work such as the Assessment, an API model or a local one. Absent:
   * the runtime's default model. It is part of the version, so a decision records which one applied.
   */
  backgroundModel?: RuntimeModelRef;
};

/** A version as served: plus the flat list of rules in force (owner rules, then enabled default rules). */
export type PolicyView = PolicyVersion & { activeRules: PolicyRule[] };

export type PolicyVersionSummary = {
  version: number;
  createdAt: string;
  mode: AcceptMode;
};

export type PolicyUpdate = {
  /** The version the caller last read. An update on any other version is refused. */
  baseVersion: number;
  mode?: AcceptMode;
  /** The whole list of the owner's rules; an entry without an id gets one. */
  rules?: Array<{ id?: string; name: string; text: string }>;
  /** Default set id to on or off; sets not named keep their state. */
  defaultSets?: Record<string, boolean>;
  /** Source id to its settings, or null to remove it; sources not named are kept. */
  sources?: Record<string, PolicySourceSettings | null>;
  /** The background model, or null to go back to the default. */
  backgroundModel?: RuntimeModelRef | null;
};
