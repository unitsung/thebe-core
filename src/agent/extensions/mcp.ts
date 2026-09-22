import {
  CONTAINER_CAPABILITY_METADATA,
  CONTAINER_RESTART_ACTION_ID,
  CONTAINER_RESTART_SCHEMA,
  CONTAINER_TOOL_DESCRIPTIONS,
  CONTAINER_TOOL_NAMES,
  CONTAINER_TOOL_SCHEMAS,
} from "../capabilities/containers.ts";
import {
  EMBY_TOOL_NAMES,
  JELLYFIN_TOOL_NAMES,
  MEDIA_PROVIDER_IDS,
  MEDIA_READ_DESCRIPTIONS,
  MEDIA_READ_SCHEMAS,
  MEDIA_READ_TOOL_NAMES,
} from "../capabilities/media.ts";
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
  error?: string;
  toolCount?: number;
  disabled?: boolean;
};

export type McpServerState = {
  name: string;
  enabled: boolean;
};

/** Agent-facing MCP capability port. Implementations belong to integrations. */
export type McpRegistry = {
  listTools(): Promise<McpToolInfo[]>;
  listServers(): Promise<McpServerInfo[]>;
  setServerEnabled(name: string, enabled: boolean): Promise<McpServerInfo | undefined>;
  invokeTool(name: string, args: unknown): Promise<string | undefined>;
  close(): void;
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

const CORE_EVENT_TOOLS: Record<
  typeof LIST_CORE_EVENTS_TOOL | typeof DIAGNOSE_FROM_EVENTS_TOOL,
  { description: string; schema: Record<string, unknown> }
> = {
  [LIST_CORE_EVENTS_TOOL]: {
    description: "List recent events from the core event log",
    schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp cutoff" },
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
} = {}): McpToolInfo[] {
  const tools: McpToolInfo[] = [];

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
