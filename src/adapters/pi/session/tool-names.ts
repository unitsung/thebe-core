/**
 * Core's tools are named by service and action (`container_restart`), and everything inside Core (approval,
 * audit, policy, the Mandate's service) relies on that. Model providers accept only letters, digits,
 * underscores and hyphens in a tool name, and reject the rest with a 400, so the model is shown a safe name
 * and the Pi boundary translates both ways. Nothing else in Core sees the safe name.
 */
const UNSAFE = /[^a-zA-Z0-9_-]/g;
const MAX_LENGTH = 64;

export type ToolNameMap = {
  /** The name the model sees. A name that is already safe is unchanged. */
  toWire(name: string): string;
  /** The name Core uses. A name that was never translated is unchanged. */
  fromWire(name: string): string;
};

function safe(name: string): string {
  return name.replace(UNSAFE, "_").slice(0, MAX_LENGTH);
}

/** A map for one session's custom tools. Two names that would collide get a numbered suffix, in order. */
export function createToolNameMap(names: readonly string[]): ToolNameMap {
  const wireOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const name of names) {
    const base = safe(name);
    let candidate = base;
    let n = 2;
    while (nameOf.has(candidate) && nameOf.get(candidate) !== name) {
      candidate = `${base.slice(0, MAX_LENGTH - 4)}_${n++}`;
    }
    wireOf.set(name, candidate);
    nameOf.set(candidate, name);
  }
  return {
    toWire: (name) => wireOf.get(name) ?? safe(name),
    fromWire: (name) => nameOf.get(name) ?? name,
  };
}
