/**
 * Claude Code's network rule for sandboxed bash: the allowlist starts empty,
 * a host that no rule matches asks the user, and "remember" saves that host.
 * One command at a time can be asked. Two overlapping commands cannot be
 * attributed to a session, so the host is denied instead of asked.
 */

const MAX_NETWORK_HOSTS = 128;

export const NETWORK_PERMISSION_TOOL = "network";

export type NetworkDecision =
  | true
  | {
      allow: false;
      reason: string;
    };

export type NetworkAsk = (params: {
  host: string;
  port: number | undefined;
}) => Promise<NetworkDecision>;

type PersistNetworkLists = (patch: {
  sandboxAllowedDomains: string[];
  sandboxDeniedDomains: string[];
}) => void | Promise<void>;

let allowed: string[] = [];
let denied: string[] = [];
let persist: PersistNetworkLists | undefined;
let onChange: (() => void) | undefined;
const inflight = new Set<NetworkAsk>();

export function networkAllowedDomains(): readonly string[] {
  return allowed;
}

export function networkDeniedDomains(): readonly string[] {
  return denied;
}

/** The sandbox re-reads the lists after this runs. */
export function setNetworkPolicyListener(
  listener: (() => void) | undefined
): void {
  onChange = listener;
}

export function configureNetworkAllowlist(input: {
  allowedDomains?: readonly string[];
  deniedDomains?: readonly string[];
  persist?: PersistNetworkLists;
}): void {
  if (input.allowedDomains)
    allowed = normalizeNetworkHostList(input.allowedDomains);
  if (input.deniedDomains)
    denied = normalizeNetworkHostList(input.deniedDomains);
  dropOverlap();
  if (input.persist) persist = input.persist;
  onChange?.();
}

export function setNetworkAllowlist(next: {
  allowedDomains?: readonly string[];
  deniedDomains?: readonly string[];
}): void {
  if (next.allowedDomains)
    allowed = normalizeNetworkHostList(next.allowedDomains);
  if (next.deniedDomains) denied = normalizeNetworkHostList(next.deniedDomains);
  dropOverlap();
  onChange?.();
}

export async function rememberNetworkHost(
  host: string,
  response: "allow" | "deny"
): Promise<void> {
  const normalized = normalizeNetworkHost(host);
  if (!normalized) return;
  allowed = allowed.filter((item) => item !== normalized);
  denied = denied.filter((item) => item !== normalized);
  if (response === "allow") allowed = trim([...allowed, normalized]);
  else denied = trim([...denied, normalized]);
  onChange?.();
  await persist?.({
    sandboxAllowedDomains: [...allowed],
    sandboxDeniedDomains: [...denied],
  });
}

/**
 * Register the command whose network prompt should be shown. The library's
 * ask callback does not say which command connected, so more than one
 * registration means the host is denied.
 */
export function trackSandboxedCommand(ask: NetworkAsk): () => void {
  inflight.add(ask);
  return () => {
    inflight.delete(ask);
  };
}

export async function decideUnmatchedHost(params: {
  host: string;
  port: number | undefined;
}): Promise<NetworkDecision> {
  if (inflight.size !== 1) {
    return {
      allow: false,
      reason:
        inflight.size === 0
          ? "no sandboxed command is waiting for this host"
          : "more than one sandboxed command is running, so this host was not asked",
    };
  }
  const ask = inflight.values().next().value;
  if (!ask) {
    return {
      allow: false,
      reason: "no sandboxed command is waiting for this host",
    };
  }
  try {
    return await ask(params);
  } catch {
    return { allow: false, reason: "permission prompt failed" };
  }
}

/** Test seam. Drops remembered hosts and any command still registered. */
export function resetNetworkAllowlist(): void {
  allowed = [];
  denied = [];
  persist = undefined;
  inflight.clear();
  onChange?.();
}

export function normalizeNetworkHost(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host.length > 253 ||
    host.includes("*") ||
    host.includes("/") ||
    host.includes(" ") ||
    host.includes("@")
  ) {
    return undefined;
  }
  if (host.includes(":")) {
    if (!/^[0-9a-f:]+$/.test(host) || host.split(":").length < 3)
      return undefined;
    return host;
  }
  const name =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  if (!name.test(host) && !ipv4.test(host)) return undefined;
  return host;
}

export function normalizeNetworkHostList(values: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const value of values) {
    const host = normalizeNetworkHost(value);
    if (!host || hosts.includes(host)) continue;
    hosts.push(host);
    if (hosts.length >= MAX_NETWORK_HOSTS) break;
  }
  return hosts;
}

export function parseNetworkHostList(
  values: unknown,
  label: string
): { ok: true; hosts: string[] } | { ok: false; message: string } {
  if (!Array.isArray(values)) {
    return { ok: false, message: `${label} must be an array of host names` };
  }
  if (values.length > MAX_NETWORK_HOSTS) {
    return {
      ok: false,
      message: `${label} accepts at most ${MAX_NETWORK_HOSTS} hosts`,
    };
  }
  const hosts: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      return { ok: false, message: `${label} must be an array of host names` };
    }
    const host = normalizeNetworkHost(value);
    if (!host)
      return { ok: false, message: `${label} has an invalid host: ${value}` };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { ok: true, hosts };
}

function dropOverlap(): void {
  const blocked = new Set(denied);
  allowed = allowed.filter((host) => !blocked.has(host));
}

function trim(hosts: string[]): string[] {
  return hosts.slice(-MAX_NETWORK_HOSTS);
}
