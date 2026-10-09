import {
  NAVIDROME_LIBRARY_MODES,
  NAVIDROME_TOOL_DESCRIPTIONS,
  NAVIDROME_TOOL_NAMES,
  NAVIDROME_TOOL_SCHEMAS,
  type NavidromeLibraryMode,
  type NavidromePlaybackMode,
  type NavidromeProvider,
  type NavidromeToolName,
} from "../capabilities/navidrome.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import { navidromeModelResult } from "./navidrome-model-result.ts";

type Policy = ReturnType<typeof createPolicyEngine>;

export function createNavidromeTools(
  provider: NavidromeProvider,
  options: {
    policy: Policy;
    callerId: string;
    modelResults?: boolean;
  },
): CustomToolDefinition[] {
  const run = (name: NavidromeToolName) =>
    async (_toolCallId: string, params: unknown) => {
      const decision = options.policy.allow(name, options.callerId);
      if (!decision.ok) {
        throw new Error(decision.reason);
      }
      const args = asObject(params);
      let result: unknown;

      switch (name) {
        case "navidrome.library":
          result = await provider.listLibrary({
            mode: libraryMode(args.mode),
            limit: integer(args.limit, 30),
            offset: integer(args.offset, 0),
          });
          break;
        case "navidrome.search":
          result = await provider.search(
            requiredString(args.query, "query"),
            integer(args.limit, 10),
          );
          break;
        case "navidrome.artist":
          result =
            (await provider.getArtist(
              requiredString(args.id, "id"),
              integer(args.limit, 12),
            )) ?? null;
          break;
        case "navidrome.lyrics":
          result =
            (await provider.getLyrics(requiredString(args.songId, "songId"))) ??
            null;
          break;
        case "navidrome.queue":
          result = await provider.getPlaybackQueue({
            songIds: stringArray(args.songIds),
            albumId: optionalString(args.albumId),
            playlistId: optionalString(args.playlistId),
            startIndex: integerOptional(args.startIndex),
            mode: playbackMode(args.mode),
            maxBitRate: integerOptional(args.maxBitRate),
            limit: integerOptional(args.limit),
            includeLyrics:
              typeof args.includeLyrics === "boolean"
                ? args.includeLyrics
                : false,
          });
          break;
        case "navidrome.playlist.create":
          result =
            (await provider.createPlaylist({
              name: requiredString(args.name, "name"),
              songIds: stringArray(args.songIds),
            })) ?? null;
          break;
        case "navidrome.playlist.update":
          await provider.updatePlaylist({
            playlistId: requiredString(args.playlistId, "playlistId"),
            name: optionalString(args.name),
            comment: optionalString(args.comment),
            isPublic:
              typeof args.isPublic === "boolean" ? args.isPublic : undefined,
            addSongIds: stringArray(args.addSongIds),
            removeSongIndexes: integerArray(args.removeSongIndexes),
          });
          result = {
            playlistId: requiredString(args.playlistId, "playlistId"),
            updated: true,
          };
          break;
        case "navidrome.playlist.delete":
          await provider.deletePlaylist(
            requiredString(args.playlistId, "playlistId"),
          );
          result = {
            playlistId: requiredString(args.playlistId, "playlistId"),
            deleted: true,
          };
          break;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(options.modelResults ? navidromeModelResult(name, result, args) : result ?? null),
          },
        ],
        details: {},
      };
    };

  return NAVIDROME_TOOL_NAMES.map((name) => ({
    name,
    label: navidromeLabel(name),
    description: NAVIDROME_TOOL_DESCRIPTIONS[name],
    parameters: NAVIDROME_TOOL_SCHEMAS[name],
    execute: run(name),
  }));
}

function navidromeLabel(name: NavidromeToolName): string {
  switch (name) {
    case "navidrome.library":
      return "Browse Navidrome";
    case "navidrome.search":
      return "Search Navidrome";
    case "navidrome.artist":
      return "Navidrome artist";
    case "navidrome.lyrics":
      return "Navidrome lyrics";
    case "navidrome.queue":
      return "Build Navidrome queue";
    case "navidrome.playlist.create":
      return "Create Navidrome playlist";
    case "navidrome.playlist.update":
      return "Update Navidrome playlist";
    case "navidrome.playlist.delete":
      return "Delete Navidrome playlist";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function integerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is number => Number.isInteger(item) && item >= 0)
    .map((item) => Math.trunc(item));
  return values.length > 0 ? values : undefined;
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function integerOptional(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function libraryMode(value: unknown): NavidromeLibraryMode {
  if (
    typeof value === "string" &&
    (NAVIDROME_LIBRARY_MODES as readonly string[]).includes(value)
  ) {
    return value as NavidromeLibraryMode;
  }
  return "recent";
}

function playbackMode(value: unknown): NavidromePlaybackMode {
  return value === "transcode" ? "transcode" : "direct";
}
