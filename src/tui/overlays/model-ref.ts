import type { RuntimeProvider } from "../../runtime/types.ts";

export function parseModelRef(ref: string): {
  providerId: string;
  modelId: string;
} {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    return {
      providerId: trimmed.slice(0, slash),
      modelId: trimmed.slice(slash + 1),
    };
  }
  return { providerId: "", modelId: trimmed };
}

export function resolveListedProvider(
  providers: RuntimeProvider[],
  token: string,
): RuntimeProvider | undefined {
  const lower = token.trim().toLowerCase();
  if (!lower) return undefined;
  return providers.find(
    (p) =>
      p.id.toLowerCase() === lower ||
      (p.displayName ?? "").toLowerCase() === lower,
  );
}

export function sameProviderId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
