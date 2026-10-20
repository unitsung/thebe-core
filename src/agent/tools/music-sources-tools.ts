import {
  NETEASE_DESCRIPTION,
  NETEASE_SCHEMA,
  NETEASE_TOOL_NAME,
  SQMUSIC_DESCRIPTION,
  SQMUSIC_DOWNLOAD_DESCRIPTION,
  SQMUSIC_DOWNLOAD_SCHEMA,
  SQMUSIC_DOWNLOAD_TOOL_NAME,
  SQMUSIC_SCHEMA,
  SQMUSIC_TOOL_NAME,
  type SqMusicDownload,
  type MusicSourcesProvider,
  type NeteaseQuery,
  type SqMusicQuery,
} from "../capabilities/music-sources.ts";
import type { CustomToolDefinition } from "../runtime/interface.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
const object = (input: unknown) => {
  if (!input || typeof input !== "object")
    throw new Error("arguments must be an object");
  return input as Record<string, unknown>;
};
const word = (value: unknown, name: string, max = 200) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${name} must contain 1–${max} characters`);
  return value.trim();
};
const limit = (value: unknown) => {
  if (value === undefined) return undefined;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 30
  )
    throw new Error("limit must be 1–30");
  return value as number;
};
const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string
): T => {
  if (!allowed.includes(value as T))
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return value as T;
};
export function parseNeteaseQuery(input: unknown): NeteaseQuery {
  const args = object(input),
    action = oneOf(
      args.action,
      ["search", "lyrics", "comments", "playlist", "toplist"] as const,
      "action"
    );
  if (action === "toplist") return { action };
  if (action === "search")
    return {
      action,
      query: word(args.query, "query"),
      ...(args.kind !== undefined
        ? {
            kind: oneOf(
              args.kind,
              ["song", "album", "artist", "playlist"] as const,
              "kind"
            ),
          }
        : {}),
      limit: limit(args.limit),
    };
  const id = word(args.id, "id", 20);
  if (!/^[0-9]+$/.test(id)) throw new Error("id must be numeric");
  return { action, id, limit: limit(args.limit) };
}
export function parseSqMusicQuery(input: unknown): SqMusicQuery {
  const args = object(input),
    action = oneOf(
      args.action,
      ["plugins", "search", "tasks"] as const,
      "action"
    );
  if (action === "plugins") return { action };
  if (action === "search")
    return {
      action,
      plugin: word(args.plugin, "plugin", 40),
      query: word(args.query, "query"),
      ...(args.kind !== undefined
        ? { kind: oneOf(args.kind, ["song", "album"] as const, "kind") }
        : {}),
      limit: limit(args.limit),
    };
  return {
    action,
    ...(args.status !== undefined
      ? {
          status: oneOf(
            args.status,
            ["waiting", "loading", "success", "error"] as const,
            "status"
          ),
        }
      : {}),
    limit: limit(args.limit),
  };
}
export function parseSqMusicDownload(input: unknown): SqMusicDownload {
  const args = object(input),
    quality =
      args.quality === undefined
        ? undefined
        : word(args.quality, "quality", 60);
  return {
    plugin: word(args.plugin, "plugin", 40),
    id: word(args.id, "id", 120),
    query: word(args.query, "query"),
    ...(quality ? { quality } : {}),
    ...(args.kind !== undefined
      ? { kind: oneOf(args.kind, ["song", "album"] as const, "kind") }
      : {}),
  };
}
export function createMusicSourcesTools(
  provider: MusicSourcesProvider,
  policy: ReturnType<typeof createPolicyEngine>,
  callerId: string
): CustomToolDefinition[] {
  const tools: CustomToolDefinition[] = [];
  const reply = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: {},
  });
  if (provider.netease) {
    const netease = provider.netease;
    tools.push({
      name: NETEASE_TOOL_NAME,
      label: "NetEase Cloud Music",
      description: NETEASE_DESCRIPTION,
      parameters: NETEASE_SCHEMA,
      async execute(_id, input) {
        const decision = policy.allow(NETEASE_TOOL_NAME, callerId);
        if (!decision.ok) throw new Error(decision.reason);
        return reply(await netease.read(parseNeteaseQuery(input)));
      },
    });
  }
  if (provider.sqmusic) {
    const sqmusic = provider.sqmusic;
    tools.push({
      name: SQMUSIC_TOOL_NAME,
      label: "SQMusic",
      description: SQMUSIC_DESCRIPTION,
      parameters: SQMUSIC_SCHEMA,
      async execute(_id, input) {
        const decision = policy.allow(SQMUSIC_TOOL_NAME, callerId);
        if (!decision.ok) throw new Error(decision.reason);
        return reply(await sqmusic.read(parseSqMusicQuery(input)));
      },
    });
    tools.push({
      name: SQMUSIC_DOWNLOAD_TOOL_NAME,
      label: "Download with SQMusic",
      description: SQMUSIC_DOWNLOAD_DESCRIPTION,
      parameters: SQMUSIC_DOWNLOAD_SCHEMA,
      async execute(_id, input) {
        const decision = policy.allow(SQMUSIC_DOWNLOAD_TOOL_NAME, callerId);
        if (!decision.ok) throw new Error(decision.reason);
        return reply(await sqmusic.download(parseSqMusicDownload(input)));
      },
    });
  }
  return tools;
}
