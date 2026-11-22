import {
  createFilesProvider,
  loadStorageConfig,
  parseStorageBackends,
  saveStorageConfig,
  storageConfigView,
} from "../../../app/storage-config.ts";
import { json, readJson } from "../json.ts";
import { invalidBody, notFound } from "../parsing/errors.ts";
import { PRODUCT_HTTP_PATH } from "../product-paths.ts";
import type { ThebeHttpContext } from "../context.ts";

/**
 * Storage settings are Core-level, not Agent-level: they work even when the
 * agent service is unavailable, and every write applies to running sessions
 * on the next file tool call.
 */
export async function handleStorageRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const testPath = `${PRODUCT_HTTP_PATH.storageSettings}/test`;
  if (
    context.path !== PRODUCT_HTTP_PATH.storageSettings &&
    context.path !== testPath
  )
    return undefined;
  const { request } = context;

  if (context.path === testPath) {
    if (request.method !== "POST")
      return json({ error: "method not allowed" }, 405);
    const body = await readJson(request);
    const wanted =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : undefined;
    const loaded = loadStorageConfig();
    const targets = wanted
      ? loaded.backends.filter((backend) => backend.id === wanted)
      : loaded.backends;
    if (wanted && targets.length === 0)
      return notFound(`unknown storage backend: ${wanted}`);
    if (targets.length === 0)
      return json({
        ok: false,
        results: [],
        issues: loaded.issues.map((issue) => issue.message),
      });
    const results = await Promise.all(
      targets.map(async (backend) => {
        try {
          const provider = createFilesProvider(backend);
          const listing = await provider.list({ path: "/" });
          return {
            id: backend.id,
            type: backend.type,
            ok: true,
            total: listing.total,
            entries: listing.entries.slice(0, 5).map((entry) => entry.name),
          };
        } catch (cause) {
          return {
            id: backend.id,
            type: backend.type,
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }
      })
    );
    return json({
      ok: results.every((result) => result.ok),
      results,
      issues: loaded.issues.map((issue) => issue.message),
    });
  }

  if (request.method === "GET") return json(storageConfigView());

  if (request.method !== "PUT")
    return json({ error: "method not allowed" }, 405);
  const body = await readJson(request);
  if (!Array.isArray(body.backends))
    return invalidBody("backends must be an array");
  const previous = loadStorageConfig();
  const parsed = parseStorageBackends(body.backends, {
    previous: previous.backends,
  });
  if (parsed.issues.length > 0)
    return json(
      {
        ok: false,
        error: "invalid storage configuration",
        issues: parsed.issues.map((issue) => issue.message),
      },
      400
    );
  let defaultId: string | null | undefined;
  if (Object.hasOwn(body, "default")) {
    if (body.default === null) {
      defaultId = null;
    } else if (typeof body.default === "string" && body.default.trim()) {
      defaultId = body.default.trim();
      if (!parsed.backends.some((backend) => backend.id === defaultId))
        return invalidBody(`default names an unknown backend: ${defaultId}`);
    } else {
      return invalidBody("default must be a backend id or null");
    }
  }
  return json(saveStorageConfig(parsed.backends, { defaultId }));
}
