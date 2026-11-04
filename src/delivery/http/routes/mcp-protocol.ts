import { asObject } from "../json.ts";

/**
 * Which MCP protocol versions `/mcp` speaks, and how a request says which one it is using.
 *
 * Two eras share the endpoint. The newest version (2026-07-28) is stateless: every request carries
 * its version and client capabilities in `_meta`, mirrored into HTTP headers, and there is no
 * `initialize`. Older versions (2025-11-25, 2025-06-18, 2025-03-26) keep their `initialize`
 * handshake and answer exactly as before. Core keeps no session either way.
 */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
/** Newest first, the order an `UnsupportedProtocolVersionError` offers them in. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
];

/** What `initialize` answers when the client names a version Core does not speak. */
export const LEGACY_FALLBACK_VERSION = "2025-06-18";

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const MCP_ERROR = {
  invalidParams: -32602,
  methodNotFound: -32601,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
} as const;

export type McpRejection = {
  status: number;
  code: number;
  message: string;
  data?: unknown;
};

export type McpRequestEra =
  | { kind: "legacy" }
  | { kind: "modern"; version: string }
  | { kind: "rejected"; rejection: McpRejection };

function rejected(
  status: number,
  code: number,
  message: string,
  data?: unknown
): McpRequestEra {
  return {
    kind: "rejected",
    rejection: { status, code, message, ...(data !== undefined && { data }) },
  };
}

function isLegacyVersion(version: string): boolean {
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** The client's version when Core speaks it as an `initialize` version; otherwise the fallback. */
export function negotiateLegacyVersion(
  params: Record<string, unknown>
): string {
  const requested = params.protocolVersion;
  return (
    LEGACY_PROTOCOL_VERSIONS.find((version) => version === requested) ??
    LEGACY_FALLBACK_VERSION
  );
}

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/s;

/** A header value that carries a name: plain, or `=?base64?...?=` when it is not header-safe. */
function decodeHeaderValue(value: string): string | undefined {
  const match = BASE64_SENTINEL.exec(value);
  if (!match) return value;
  const encoded = match[1] ?? "";
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  return Buffer.from(encoded, "base64").toString("utf8");
}

/**
 * Decide which era a request belongs to and, for the newest, check what the specification
 * requires before the method runs.
 *
 * - `initialize` is always the older handshake.
 * - A request naming no version (no `MCP-Protocol-Version` header, no `_meta` version) is an older
 *   client's, and is answered as it always was. `server/discover` is the exception: it exists only
 *   in the newest version, so a bare one is a newest-style request that is missing its `_meta`.
 * - A version Core does not speak, in the header or in `_meta`, is an `UnsupportedProtocolVersion`.
 * - An older version in the header is an older client's request; only the newest version's rules
 *   (headers must match the body) are enforced.
 */
export function classifyMcpRequest(
  request: Request,
  body: Record<string, unknown>,
  method: string
): McpRequestEra {
  if (method === "initialize") return { kind: "legacy" };

  const params = asObject(body.params);
  const meta = asObject(params._meta);
  const metaVersion = meta[META_PROTOCOL_VERSION];
  const headerVersion =
    request.headers.get("mcp-protocol-version")?.trim() || undefined;

  if (metaVersion !== undefined && typeof metaVersion !== "string") {
    return rejected(
      400,
      MCP_ERROR.invalidParams,
      `_meta["${META_PROTOCOL_VERSION}"] must be a string`
    );
  }
  for (const requested of [metaVersion, headerVersion]) {
    if (
      requested !== undefined &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ) {
      return rejected(
        400,
        MCP_ERROR.unsupportedProtocolVersion,
        "Unsupported protocol version",
        {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          requested,
        }
      );
    }
  }

  const named = [metaVersion, headerVersion].filter(
    (version): version is string => version !== undefined
  );
  if (named.length === 0 && method !== "server/discover") {
    return { kind: "legacy" };
  }
  if (named.length > 0 && named.every(isLegacyVersion)) {
    return { kind: "legacy" };
  }

  // The newest era: everything below is what its specification makes a hard requirement.
  if (metaVersion === undefined) {
    return rejected(
      400,
      MCP_ERROR.invalidParams,
      `Missing params._meta["${META_PROTOCOL_VERSION}"]`
    );
  }
  const capabilities = meta[META_CLIENT_CAPABILITIES];
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return rejected(
      400,
      MCP_ERROR.invalidParams,
      `Missing params._meta["${META_CLIENT_CAPABILITIES}"]`
    );
  }
  const mismatch = (message: string) =>
    rejected(400, MCP_ERROR.headerMismatch, `Header mismatch: ${message}`);
  if (headerVersion === undefined) {
    return mismatch("MCP-Protocol-Version header is missing");
  }
  if (headerVersion !== metaVersion) {
    return mismatch(
      `MCP-Protocol-Version header value '${headerVersion}' does not match _meta value '${metaVersion}'`
    );
  }
  const methodHeader = request.headers.get("mcp-method");
  if (methodHeader === null) return mismatch("Mcp-Method header is missing");
  if (methodHeader !== method) {
    return mismatch(
      `Mcp-Method header value '${methodHeader}' does not match body value '${method}'`
    );
  }
  if (method === "tools/call") {
    const name = params.name;
    if (typeof name !== "string" || !name) {
      return rejected(
        400,
        MCP_ERROR.invalidParams,
        "tools/call requires params.name"
      );
    }
    const nameHeader = request.headers.get("mcp-name");
    if (nameHeader === null) return mismatch("Mcp-Name header is missing");
    const decoded = decodeHeaderValue(nameHeader);
    if (decoded === undefined)
      return mismatch("Mcp-Name header is not valid base64");
    if (decoded !== name) {
      return mismatch(
        `Mcp-Name header value '${decoded}' does not match body value '${name}'`
      );
    }
  }
  return { kind: "modern", version: metaVersion };
}

/** A newest-era result: it says it is complete and names the server. */
export function modernResult(
  result: Record<string, unknown>,
  serverVersion: string
): Record<string, unknown> {
  return {
    resultType: "complete",
    ...result,
    _meta: {
      ...asObject(result._meta),
      [META_SERVER_INFO]: { name: "thebe-core", version: serverVersion },
    },
  };
}
