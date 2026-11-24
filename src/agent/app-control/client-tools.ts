import { randomUUID } from "node:crypto";
import type {
  CustomToolDefinition,
  CustomToolResult,
  NormalizedEvent,
} from "../runtime/interface.ts";
import { summarizeArgs } from "../security/redaction.ts";

export type AppControlToolName =
  | "app_settings_read"
  | "app_settings_update"
  | "app_service_add"
  | "app_open";

export type ClientToolResult = {
  ok: boolean;
  summary?: string;
  data?: unknown;
  errorCode?: string;
  errorMessage?: string;
};

export type ClientToolRequest = {
  id: string;
  sessionId: string;
  toolName: AppControlToolName;
  arguments: Record<string, unknown>;
  requiresApproval: boolean;
  createdAt: string;
};

type PendingRequest = ClientToolRequest & {
  resolve(result: ClientToolResult): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
};

type Emit = (event: NormalizedEvent) => void;

const SETTINGS = [
  "theme",
  "language",
  "network_mode",
  "app_icon",
  "home_media_source",
  "home_files_instance",
  "home_docker_instance",
  "hidden_services",
  "ask_route",
  "show_message_stats",
  "expand_reasoning",
  "expand_tools",
  "push_permission",
  "push_activity",
] as const;

const OPEN_TARGETS = [
  "settings",
  "core",
  "services",
  "library",
  "lab",
  "downloads",
  "activity",
  "audit",
  "ask",
  "service",
] as const;

const TOOL_DEFINITIONS: Array<{
  name: AppControlToolName;
  label: string;
  description: string;
  parameters: unknown;
  requiresApproval: boolean;
}> = [
  {
    name: "app_settings_read",
    label: "Read App settings",
    description:
      "Read the paired Thebe App's current preferences, configured services and service type ids. Use this before changing an App setting or adding a service. It runs on the App, not on this Core host.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    requiresApproval: false,
  },
  {
    name: "app_settings_update",
    label: "Change App setting",
    description:
      "Change one preference in the paired Thebe App. Use app_settings_read first and pass the exact setting id. The person approves this write in the App before it runs there.",
    parameters: {
      type: "object",
      properties: {
        setting: {
          type: "string",
          description: "The App setting id",
          enum: SETTINGS,
        },
        value: {
          type: "string",
          description:
            "The new value. Booleans accept true/false. hidden_services accepts comma-separated service type ids. An empty string clears an optional instance or source.",
        },
      },
      required: ["setting", "value"],
      additionalProperties: false,
    },
    requiresApproval: true,
  },
  {
    name: "app_service_add",
    label: "Add service to App",
    description:
      "Add a self-hosted service to the paired Thebe App. Only use a type, address and credentials the person supplied for this request. The App authenticates and saves it after the person approves; it never runs on the Core host.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Service type raw id, for example emby, jellyfin, immich, openlist, qbittorrent or aria2",
        },
        label: {
          type: "string",
          description: "Display name; defaults to the service name",
        },
        url: {
          type: "string",
          description: "Base URL, including http:// or https://",
        },
        token: {
          type: "string",
          description: "Pre-issued user token, if the service accepts one",
        },
        api_key: {
          type: "string",
          description: "API key, if the service uses one",
        },
        username: {
          type: "string",
          description: "Username, if the service uses credentials",
        },
        password: {
          type: "string",
          description: "Password, if the service uses credentials",
        },
        fallback_url: {
          type: "string",
          description: "Optional remote or fallback base URL",
        },
        allow_self_signed: {
          type: "boolean",
          description: "Allow the service's self-signed certificate",
        },
        unifi_auth_mode: {
          type: "string",
          description: "UniFi only: site_manager or local_network",
          enum: ["site_manager", "local_network"],
        },
        proxmox_auth_mode: {
          type: "string",
          description: "Proxmox only: credentials or api_token",
          enum: ["credentials", "api_token"],
        },
        proxmox_realm: {
          type: "string",
          description: "Proxmox realm, usually pam",
        },
        mfa_code: {
          type: "string",
          description: "One-time code, if required",
        },
      },
      required: ["type", "url"],
      additionalProperties: false,
    },
    requiresApproval: true,
  },
  {
    name: "app_open",
    label: "Open App screen",
    description:
      "Open a screen in the paired Thebe App: settings, core, services, library, lab, downloads, activity, audit, ask, or one configured service. Use it when the person should see the result there.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "The App page to open",
          enum: OPEN_TARGETS,
        },
        service_type: {
          type: "string",
          description: "Required only when target is service",
        },
        instance_id: {
          type: "string",
          description: "Optional service instance UUID",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    requiresApproval: false,
  },
];

export const APP_CONTROL_TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

export function createAppControlTools(options: {
  sessionId: string;
  bridge: ClientToolBridge;
  emit: Emit;
}): CustomToolDefinition[] {
  return TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    exposure: "direct" as const,
    requiresApproval: definition.requiresApproval,
    async execute(
      _toolCallId: string,
      input: unknown,
      signal?: AbortSignal
    ): Promise<CustomToolResult> {
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const result = await options.bridge.request({
        sessionId: options.sessionId,
        toolName: definition.name,
        arguments: args,
        requiresApproval: definition.requiresApproval,
        emit: options.emit,
        signal,
      });
      const payload = {
        ok: result.ok,
        summary: result.summary ?? (result.ok ? "Completed" : "Failed"),
        ...(result.data === undefined ? {} : { data: result.data }),
        ...(result.ok
          ? {}
          : {
              error: {
                code: result.errorCode ?? "internal",
                message:
                  result.errorMessage ??
                  result.summary ??
                  "The App could not complete the request.",
              },
            }),
      };
      return {
        isError: !result.ok,
        content: [{ type: "text", text: JSON.stringify(payload) }],
        details: {},
      };
    },
  }));
}

export type ClientToolBridge = ReturnType<typeof createClientToolBridge>;

export function createClientToolBridge(
  options: {
    now?: () => Date;
    timeoutMs?: number;
    id?: () => string;
  } = {}
) {
  const pending = new Map<string, PendingRequest>();
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 60 * 1000;
  const makeId = options.id ?? (() => randomUUID());

  function view(row: PendingRequest): ClientToolRequest {
    return {
      id: row.id,
      sessionId: row.sessionId,
      toolName: row.toolName,
      arguments: row.arguments,
      requiresApproval: row.requiresApproval,
      createdAt: row.createdAt,
    };
  }

  return {
    request(input: {
      sessionId: string;
      toolName: AppControlToolName;
      arguments: Record<string, unknown>;
      requiresApproval: boolean;
      emit: Emit;
      signal?: AbortSignal;
    }): Promise<ClientToolResult> {
      if (input.signal?.aborted) {
        return Promise.reject(new Error("App request cancelled"));
      }
      const id = makeId();
      const row: PendingRequest = {
        id,
        sessionId: input.sessionId,
        toolName: input.toolName,
        arguments: input.arguments,
        requiresApproval: input.requiresApproval,
        createdAt: now().toISOString(),
        resolve: () => {},
        reject: () => {},
      };
      const promise = new Promise<ClientToolResult>((resolve, reject) => {
        row.resolve = resolve;
        row.reject = reject;
      });
      pending.set(id, row);
      row.timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        row.reject(new Error("The Thebe App did not answer this request."));
      }, timeoutMs);
      row.timer.unref?.();
      const cancel = () => {
        if (!pending.delete(id)) return;
        row.reject(new Error("App request cancelled"));
      };
      input.signal?.addEventListener("abort", cancel, { once: true });
      const name = input.toolName;
      input.emit({
        type: "client_tool_requested",
        requestId: id,
        sessionId: input.sessionId,
        toolName: name,
        argsSummary: summarizeArgs(input.arguments),
        requiresApproval: input.requiresApproval,
      });
      return promise.finally(() => {
        input.signal?.removeEventListener("abort", cancel);
      });
    },

    list(sessionId: string): ClientToolRequest[] {
      return [...pending.values()]
        .filter((row) => row.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(view);
    },

    get(sessionId: string, id: string): ClientToolRequest | undefined {
      const row = pending.get(id);
      return row?.sessionId === sessionId ? view(row) : undefined;
    },

    resolve(sessionId: string, id: string, result: ClientToolResult): boolean {
      const row = pending.get(id);
      if (!row || row.sessionId !== sessionId) return false;
      pending.delete(id);
      if (row.timer) clearTimeout(row.timer);
      row.resolve(result);
      return true;
    },

    cancelSession(sessionId: string): void {
      for (const [id, row] of pending) {
        if (row.sessionId !== sessionId) continue;
        pending.delete(id);
        if (row.timer) clearTimeout(row.timer);
        row.reject(new Error("The Session ended before the App answered."));
      }
    },
  };
}
