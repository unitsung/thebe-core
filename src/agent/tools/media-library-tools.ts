import {
  EMBY_LOOKUP_TOOL_NAMES,
  IMMICH_SEARCH_TOOL_NAMES,
  JELLYFIN_LOOKUP_TOOL_NAMES,
  MEDIA_LOOKUP_DESCRIPTIONS,
  MEDIA_LOOKUP_SCHEMAS,
  clampMediaLimit,
  clampMediaPage,
  clampMediaStart,
  type MediaItemDetail,
  type MediaLibraryProvider,
  type MediaLookupToolName,
  type PhotoLibraryProvider,
} from "../capabilities/media.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";
import type { createPolicyEngine } from "../security/policy/policy-engine.ts";
import {
  asObject,
  integerOptional,
  optionalString,
  requiredString,
  textResult,
} from "./tool-args.ts";

type Policy = ReturnType<typeof createPolicyEngine>;

const OVERVIEW_LIMIT = 2000;

export function createMediaLibraryTools(
  service: "emby" | "jellyfin",
  provider: MediaLibraryProvider,
  options: { policy: Policy; callerId: string; modelResults?: boolean }
): CustomToolDefinition[] {
  const names =
    service === "emby" ? EMBY_LOOKUP_TOOL_NAMES : JELLYFIN_LOOKUP_TOOL_NAMES;
  return names.map((name) => ({
    name,
    label: name.endsWith("_search") ? `Search ${service}` : `${service} item`,
    description: MEDIA_LOOKUP_DESCRIPTIONS[name],
    parameters: MEDIA_LOOKUP_SCHEMAS[name],
    execute: async (_toolCallId: string, params: unknown) => {
      const decision = options.policy.allow(name, options.callerId);
      if (!decision.ok) throw new Error(decision.reason);
      const args = asObject(params);
      let result: unknown;
      if (name.endsWith("_search")) {
        const query = optionalString(args.query);
        const person = optionalString(args.person);
        if (!query && !person) throw new Error("query or person is required");
        result = await provider.searchItems({
          query,
          person,
          year: integerOptional(args.year),
          itemTypes: stringArray(args.itemTypes),
          startIndex: clampMediaStart(integerOptional(args.startIndex)),
          limit: clampMediaLimit(integerOptional(args.limit)),
        });
      } else {
        result = await provider.getItem(requiredString(args.id, "id"));
      }
      return textResult(present(name, result, options.modelResults === true));
    },
  }));
}

export function createImmichSearchTools(
  provider: PhotoLibraryProvider,
  options: { policy: Policy; callerId: string; modelResults?: boolean }
): CustomToolDefinition[] {
  return IMMICH_SEARCH_TOOL_NAMES.map((name) => ({
    name,
    label: "Search Immich",
    description: MEDIA_LOOKUP_DESCRIPTIONS[name],
    parameters: MEDIA_LOOKUP_SCHEMAS[name],
    execute: async (_toolCallId: string, params: unknown) => {
      const decision = options.policy.allow(name, options.callerId);
      if (!decision.ok) throw new Error(decision.reason);
      const args = asObject(params);
      const assets = await provider.searchSemantic(
        requiredString(args.query, "query"),
        {
          size: clampMediaLimit(integerOptional(args.size)),
          page: clampMediaPage(integerOptional(args.page)),
        }
      );
      return textResult(assets);
    },
  }));
}

function present(
  name: MediaLookupToolName,
  result: unknown,
  modelResults: boolean
): unknown {
  if (
    !modelResults ||
    !name.endsWith("_item") ||
    !result ||
    typeof result !== "object"
  ) {
    return result ?? null;
  }
  const detail = result as MediaItemDetail;
  if (!detail.overview || detail.overview.length <= OVERVIEW_LIMIT)
    return detail;
  return {
    ...detail,
    overview: detail.overview.slice(0, OVERVIEW_LIMIT),
    overviewTruncated: true,
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === "string"
  );
  return values.length > 0 ? values : undefined;
}
