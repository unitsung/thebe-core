import type { RuntimeMcpServer } from "../runtime/interface.ts";
import {
  CONTAINER_CAPABILITY_METADATA,
  CONTAINER_RESTART_ACTION_ID,
  CONTAINER_RESTART_SCHEMA,
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
  CONTAINER_TOOL_SCHEMAS,
} from "../capabilities/containers.ts";
import { MUSIC_RESEARCH_DESCRIPTION, MUSIC_RESEARCH_SCHEMA } from "../capabilities/music-research.ts";
import {
  EMBY_LOOKUP_TOOL_NAMES,
  EMBY_TOOL_NAMES,
  IMMICH_SEARCH_TOOL_NAMES,
  JELLYFIN_LOOKUP_TOOL_NAMES,
  JELLYFIN_TOOL_NAMES,
  MEDIA_LOOKUP_DESCRIPTIONS,
  MEDIA_LOOKUP_SCHEMAS,
  MEDIA_PROVIDER_IDS,
  MEDIA_READ_DESCRIPTIONS,
  MEDIA_READ_SCHEMAS,
  MEDIA_READ_TOOL_NAMES,
  type MediaLookupToolName,
} from "../capabilities/media.ts";
import {
  NAVIDROME_CAPABILITY_METADATA,
  NAVIDROME_PROVIDER_ID,
  NAVIDROME_TOOL_DESCRIPTIONS,
  NAVIDROME_TOOL_NAMES,
  NAVIDROME_TOOL_SCHEMAS,
  type NavidromeToolName,
} from "../capabilities/navidrome.ts";
import {
  STRM_REPAIR_CAPABILITY_ID,
  STRM_REPAIR_DESCRIPTION,
  STRM_REPAIR_SCHEMA,
  type StrmRepairProvider,
} from "../capabilities/strm.ts";

export const HOMELAB_CAPABILITY_CATEGORIES = [
  "files",
  "media",
  "downloads",
  "containers",
  "automation",
  "diagnostics",
  "compute",
  "storage",
  "network",
  "photos",
  "other",
] as const;

export type HomelabCapabilityCategory =
  (typeof HOMELAB_CAPABILITY_CATEGORIES)[number];

export const HOMELAB_CAPABILITY_PERMISSIONS = ["read", "confirm", "admin"] as const;
export type HomelabCapabilityPermission =
  (typeof HOMELAB_CAPABILITY_PERMISSIONS)[number];

export const HOMELAB_CAPABILITY_EXECUTIONS = ["direct", "agent", "goal", "either"] as const;
export type HomelabCapabilityExecution =
  (typeof HOMELAB_CAPABILITY_EXECUTIONS)[number];
export const DEFAULT_CAPABILITY_EXECUTION =
  "direct" satisfies HomelabCapabilityExecution;

export const HOMELAB_CAPABILITY_SOURCES = ["core", "external"] as const;
export type HomelabCapabilitySource = (typeof HOMELAB_CAPABILITY_SOURCES)[number];
export const CORE_CAPABILITY_SOURCE = HOMELAB_CAPABILITY_SOURCES[0];
export const EXTERNAL_CAPABILITY_SOURCE = HOMELAB_CAPABILITY_SOURCES[1];

export const CORE_CAPABILITY_SERVER = "thebe-core";
export const CORE_CONTAINER_SERVICE = "arcane";
export const DEFAULT_CAPABILITY_OUTPUT_KIND = "json";

export const HOMELAB_RESOURCE_KINDS = {
  container: "container",
  mediaLibrary: "media_library",
  mediaItem: "media_item",
  artist: "artist",
  song: "song",
  playlist: "playlist",
  strm: "strm",
  playbackSession: "playback_session",
  photo: "photo",
  album: "album",
} as const;

export const LIST_CORE_EVENTS_TOOL = "list_core_events";
export const DIAGNOSE_FROM_EVENTS_TOOL = "diagnose_from_events";

/**
 * Stable metadata shared by native UI, agent prompts, and external plugins.
 * The MCP tool name remains the invocation id for backwards compatibility.
 */
export type HomelabCapability = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  originalName?: string;
  category: HomelabCapabilityCategory;
  permission: HomelabCapabilityPermission;
  effect?: "read" | "write";
  risk?: "low" | "disruptive";
  approval?: "none" | "required";
  service?: string;
  source: HomelabCapabilitySource;
  serverName?: string;
  resourceKinds?: string[];
  execution?: HomelabCapabilityExecution;
  background?: boolean;
  destructive?: boolean;
  outputKind?: string;
};

/** MCP-compatible alias retained for existing callers and clients. */
export type McpToolInfo = HomelabCapability;

export type McpServerInfo = {
  name: string;
  command?: string;
  url?: string;
  service?: string;
  category?: HomelabCapabilityCategory;
  permission?: HomelabCapabilityPermission;
  status?: string;
  disabled?: boolean;
};

export type McpServerState = {
  name: string;
  enabled: boolean;
};

/** Agent-facing MCP capability port. Implementations belong to integrations. */
export type McpServerRegistration = {
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** One sentence for the model's server list. */
  description?: string;
  /** How the model reaches the tools; the runtime's default is `codemode`. */
  exposure?: "codemode" | "deferred" | "direct" | "hidden";
};

export type McpRegistry = {
  addServer?(input: McpServerRegistration): Promise<McpServerInfo>;
  listTools(): Promise<McpToolInfo[]>;
  listServers(): Promise<McpServerInfo[]>;
  setServerEnabled(name: string, enabled: boolean): Promise<McpServerInfo | undefined>;
  /** Deletes a server Thebe registered. Resolves false when no such server exists. */
  removeServer?(name: string): Promise<boolean>;
  /** Servers for the runtime's own MCP client. Synchronous because the runtime reads it on session start. */
  runtimeServers?(): RuntimeMcpServer[];
  invokeTool(name: string, args: unknown): Promise<string | undefined>;
  invokeToolResult?(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
  close(): void;
};

/** Standard MCP payload; concrete SDK types remain in adapters. */
export type McpCallResult = {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function createEmptyMcpRegistry(): McpRegistry {
  return {
    async listTools(): Promise<McpToolInfo[]> { return []; },
    async listServers(): Promise<McpServerInfo[]> { return []; },
    async setServerEnabled(): Promise<McpServerInfo | undefined> { return undefined; },
    async invokeTool(): Promise<string | undefined> { return undefined; },
    close(): void {},
  };
}

export const CORE_EVENT_TOOLS: Record<
  typeof LIST_CORE_EVENTS_TOOL | typeof DIAGNOSE_FROM_EVENTS_TOOL,
  { description: string; schema: Record<string, unknown> }
> = {
  [LIST_CORE_EVENTS_TOOL]: {
    description: "List recent events from the core event log",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to return" },
        sessionId: { type: "string", description: "Filter by session ID" },
      },
    },
  },
  [DIAGNOSE_FROM_EVENTS_TOOL]: {
    description: "Diagnose issues from recorded core events",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Diagnostic category" },
      },
    },
  },
};

/** Tool shape on the wire (`tools/list`): standard MCP fields, with Thebe's extras namespaced under `_meta`. */
export type McpWireTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
  _meta: Record<string, unknown>;
};

/**
 * Derive MCP tool annotations from Core's own classification, never from a remote server's claims.
 * A capability is read-only when its effect (or, without one, its permission) says so. A write is
 * destructive unless Core classified it `risk: "low"`, which is the safe default for unclassified
 * external tools. Hosts treat these as hints; Core's policy engine remains the enforcement point.
 */
export function toMcpWireTool(capability: HomelabCapability): McpWireTool {
  const readOnly = (capability.effect ?? (capability.permission === "read" ? "read" : "write")) === "read";
  return {
    name: capability.name,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly && capability.risk !== "low",
      openWorldHint: capability.source === EXTERNAL_CAPABILITY_SOURCE || capability.service === "public-music",
    },
    _meta: {
      "thebe/category": capability.category,
      ...(capability.resourceKinds?.length ? { "thebe/resourceKinds": capability.resourceKinds } : {}),
      ...(capability.approval ? { "thebe/approval": capability.approval } : {}),
    },
  };
}

export function withProductMetadata(capability: HomelabCapability): HomelabCapability {
  return {
    ...capability,
    resourceKinds: capability.resourceKinds ?? defaultResourceKinds(capability),
    execution: capability.execution ?? DEFAULT_CAPABILITY_EXECUTION,
    background: capability.background ?? capability.category === "diagnostics",
    destructive:
      capability.destructive ??
      (capability.effect === "write" || capability.approval === "required"),
    outputKind: capability.outputKind ?? DEFAULT_CAPABILITY_OUTPUT_KIND,
  };
}

const MEDIA_RESOURCE_KINDS: Record<(typeof MEDIA_READ_TOOL_NAMES)[number], string[]> = {
  "emby.libraries": [HOMELAB_RESOURCE_KINDS.mediaLibrary],
  "emby.recent": [HOMELAB_RESOURCE_KINDS.mediaItem],
  "emby.sessions": [HOMELAB_RESOURCE_KINDS.playbackSession],
  "jellyfin.libraries": [HOMELAB_RESOURCE_KINDS.mediaLibrary],
  "jellyfin.recent": [HOMELAB_RESOURCE_KINDS.mediaItem],
  "jellyfin.sessions": [HOMELAB_RESOURCE_KINDS.playbackSession],
  "immich.assets": [HOMELAB_RESOURCE_KINDS.photo],
  "immich.albums": [HOMELAB_RESOURCE_KINDS.album],
  "immich.statistics": [HOMELAB_RESOURCE_KINDS.photo],
};

const NAVIDROME_RESOURCE_KINDS: Record<NavidromeToolName, string[]> = {
  "navidrome.library": [
    HOMELAB_RESOURCE_KINDS.mediaLibrary,
    HOMELAB_RESOURCE_KINDS.artist,
    HOMELAB_RESOURCE_KINDS.album,
    HOMELAB_RESOURCE_KINDS.song,
    HOMELAB_RESOURCE_KINDS.playlist,
  ],
  "navidrome.search": [
    HOMELAB_RESOURCE_KINDS.artist,
    HOMELAB_RESOURCE_KINDS.album,
    HOMELAB_RESOURCE_KINDS.song,
  ],
  "navidrome.artist": [HOMELAB_RESOURCE_KINDS.artist],
  "navidrome.lyrics": [HOMELAB_RESOURCE_KINDS.song],
  "navidrome.queue": [HOMELAB_RESOURCE_KINDS.playbackSession],
  "navidrome.playlist.create": [HOMELAB_RESOURCE_KINDS.playlist],
  "navidrome.playlist.update": [HOMELAB_RESOURCE_KINDS.playlist],
  "navidrome.playlist.delete": [HOMELAB_RESOURCE_KINDS.playlist],
};

function defaultResourceKinds(capability: HomelabCapability): string[] {
  if (capability.category === "containers") return [HOMELAB_RESOURCE_KINDS.container];
  if (capability.id.startsWith("strm.")) return [HOMELAB_RESOURCE_KINDS.strm];
  const mediaKinds = MEDIA_RESOURCE_KINDS[capability.id as (typeof MEDIA_READ_TOOL_NAMES)[number]];
  if (mediaKinds) return mediaKinds;
  if (capability.category === "media") return [HOMELAB_RESOURCE_KINDS.mediaLibrary];
  return [];
}

function mediaServiceForTool(name: (typeof MEDIA_READ_TOOL_NAMES)[number]): string {
  if ((EMBY_TOOL_NAMES as readonly string[]).includes(name)) return MEDIA_PROVIDER_IDS.emby;
  if ((JELLYFIN_TOOL_NAMES as readonly string[]).includes(name)) return MEDIA_PROVIDER_IDS.jellyfin;
  return MEDIA_PROVIDER_IDS.immich;
}

export function listCoreMcpTools(options: {
  strmRepairProvider?: StrmRepairProvider;
  navidrome?: boolean;
  musicResearch?: boolean;
  emby?: boolean;
  jellyfin?: boolean;
  immich?: boolean;
} = {}): McpToolInfo[] {
  const tools: McpToolInfo[] = [];
  if (options.musicResearch) tools.push(withProductMetadata({ id: "music_research", name: "music_research", description: MUSIC_RESEARCH_DESCRIPTION, inputSchema: MUSIC_RESEARCH_SCHEMA, category: "media", permission: "read", service: "public-music", source: CORE_CAPABILITY_SOURCE, serverName: CORE_CAPABILITY_SERVER }));

  for (const name of CONTAINER_TOOL_NAMES) {
    const meta = CONTAINER_CAPABILITY_METADATA[name];
    tools.push(withProductMetadata({
      id: name,
      name,
      description:
        CONTAINER_TOOL_DESCRIPTIONS[name] || `Core container tool ${name}`,
      inputSchema: CONTAINER_TOOL_SCHEMAS[name],
      category: "containers",
      permission: meta.permission,
      effect: meta.effect,
      risk: meta.risk,
      approval: meta.approval,
      service: CORE_CONTAINER_SERVICE,
      source: CORE_CAPABILITY_SOURCE,
      serverName: CORE_CAPABILITY_SERVER,
    }));
  }
  const restartMeta = CONTAINER_CAPABILITY_METADATA[CONTAINER_RESTART_ACTION_ID];
  tools.push(withProductMetadata({
    id: CONTAINER_RESTART_ACTION_ID,
    name: CONTAINER_RESTART_ACTION_ID,
    description: CONTAINER_TOOL_DESCRIPTIONS[CONTAINER_RESTART_ACTION_ID],
    inputSchema: CONTAINER_RESTART_SCHEMA,
    category: "containers",
    permission: restartMeta.permission,
    effect: restartMeta.effect,
    risk: restartMeta.risk,
    approval: restartMeta.approval,
    service: CORE_CONTAINER_SERVICE,
    source: CORE_CAPABILITY_SOURCE,
    serverName: CORE_CAPABILITY_SERVER,
    destructive: true,
    background: false,
  }));

  for (const [name, meta] of Object.entries(CORE_EVENT_TOOLS)) {
    tools.push(withProductMetadata({
      id: name,
      name,
      description: meta.description,
      inputSchema: meta.schema,
      category: "diagnostics",
      permission: "read",
      service: CORE_CAPABILITY_SERVER,
      source: CORE_CAPABILITY_SOURCE,
      serverName: CORE_CAPABILITY_SERVER,
      background: true,
    }));
  }

  for (const name of MEDIA_READ_TOOL_NAMES) {
    tools.push(withProductMetadata({
      id: name,
      name,
      description: MEDIA_READ_DESCRIPTIONS[name],
      inputSchema: MEDIA_READ_SCHEMAS[name],
      category: "media",
      permission: "read",
      effect: "read",
      risk: "low",
      approval: "none",
      service: mediaServiceForTool(name),
      source: CORE_CAPABILITY_SOURCE,
      serverName: CORE_CAPABILITY_SERVER,
    }));
  }

  const lookupNames: MediaLookupToolName[] = [
    ...(options.emby ? EMBY_LOOKUP_TOOL_NAMES : []),
    ...(options.jellyfin ? JELLYFIN_LOOKUP_TOOL_NAMES : []),
    ...(options.immich ? IMMICH_SEARCH_TOOL_NAMES : []),
  ];
  for (const name of lookupNames) {
    const service = name.startsWith("emby.")
      ? MEDIA_PROVIDER_IDS.emby
      : name.startsWith("jellyfin.")
        ? MEDIA_PROVIDER_IDS.jellyfin
        : MEDIA_PROVIDER_IDS.immich;
    tools.push(withProductMetadata({
      id: name,
      name,
      description: MEDIA_LOOKUP_DESCRIPTIONS[name],
      inputSchema: MEDIA_LOOKUP_SCHEMAS[name],
      category: "media",
      permission: "read",
      effect: "read",
      risk: "low",
      approval: "none",
      service,
      source: CORE_CAPABILITY_SOURCE,
      serverName: CORE_CAPABILITY_SERVER,
      resourceKinds: [
        name.startsWith("immich.")
          ? HOMELAB_RESOURCE_KINDS.photo
          : HOMELAB_RESOURCE_KINDS.mediaItem,
      ],
      execution: "direct",
      background: false,
    }));
  }

  if (options.navidrome) {
    for (const name of NAVIDROME_TOOL_NAMES) {
      const meta = NAVIDROME_CAPABILITY_METADATA[name];
      tools.push(withProductMetadata({
        id: name,
        name,
        description: NAVIDROME_TOOL_DESCRIPTIONS[name],
        inputSchema: NAVIDROME_TOOL_SCHEMAS[name],
        category: "media",
        permission: meta.permission,
        effect: meta.effect,
        risk: meta.risk,
        approval: meta.approval,
        service: NAVIDROME_PROVIDER_ID,
        source: CORE_CAPABILITY_SOURCE,
        serverName: CORE_CAPABILITY_SERVER,
        resourceKinds: NAVIDROME_RESOURCE_KINDS[name],
        execution: meta.effect === "write" ? "agent" : "direct",
        background: false,
        outputKind: name === "navidrome.queue" ? "audio_queue" : "json",
      }));
    }
  }

  if (options.strmRepairProvider) {
    tools.push(withProductMetadata({
      id: STRM_REPAIR_CAPABILITY_ID,
      name: STRM_REPAIR_CAPABILITY_ID,
      description: STRM_REPAIR_DESCRIPTION,
      inputSchema: STRM_REPAIR_SCHEMA,
      category: "media",
      permission: "confirm",
      effect: "write",
      risk: "low",
      approval: "none",
      service: options.strmRepairProvider.service,
      source: CORE_CAPABILITY_SOURCE,
      serverName: CORE_CAPABILITY_SERVER,
      execution: "either",
      background: true,
    }));
  }

  return tools;
}
