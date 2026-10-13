import { describe, expect, it } from "vitest";
import { OpenAPIService } from "./openapi.ts";

/**
 * Live checks for the generic OpenAPI bridge (no per-service code). Opt-in:
 *
 *   THEBE_SERVICE_API_LIVE=1 npx vitest run src/adapters/service-api/live.test.ts
 */
const liveIt = process.env.THEBE_SERVICE_API_LIVE === "1" ? it : it.skip;

describe("live service_api bridge", () => {
  liveIt(
    "discovers and reads a real public OpenAPI service",
    async () => {
      const petstore = new OpenAPIService({
        id: "petstore",
        baseURL: "https://petstore3.swagger.io/api/v3",
        readOperations: ["findPetsByStatus"],
      });

      const listing = (await petstore.catalog({ query: "findByStatus" })) as {
        total: number;
        operations: Array<{ id: string; method: string; approval: string }>;
      };
      expect(listing.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "findPetsByStatus",
            method: "GET",
            approval: "read",
          }),
        ])
      );

      const detail = (await petstore.catalog({
        operationId: "findPetsByStatus",
      })) as {
        operations: Array<{ parameters?: unknown }>;
      };
      expect(detail.operations[0]?.parameters).toBeTruthy();

      const read = (await petstore.request({
        method: "GET",
        path: "/pet/findByStatus?status=available",
        readOnly: true,
      })) as { ok: boolean; status: number; body: unknown };
      expect(read.ok).toBe(true);
      expect(read.status).toBe(200);
      expect(Array.isArray(read.body)).toBe(true);
      expect((read.body as unknown[]).length).toBeGreaterThan(0);
    },
    60_000
  );

  liveIt(
    "parses the real *arr OpenAPI specs with no per-service code",
    async () => {
      for (const [id, baseURL, openapiPath, min] of [
        [
          "radarr",
          "https://raw.githubusercontent.com/Radarr/Radarr/develop/src",
          "/Radarr.Api.V3/openapi.json",
          100,
        ],
        [
          "sonarr",
          "https://raw.githubusercontent.com/Sonarr/Sonarr/develop/src",
          "/Sonarr.Api.V5/openapi.json",
          100,
        ],
      ] as const) {
        const service = new OpenAPIService({ id, baseURL, openapiPath });
        const listing = (await service.catalog({ limit: 40 })) as {
          version?: string;
          total: number;
          operations: Array<{ id: string; method: string; path: string }>;
        };
        expect(listing.version, `${id} spec version`).toMatch(/^3\./);
        expect(listing.total, `${id} operation count`).toBeGreaterThan(min);
        expect(listing.operations.length).toBeGreaterThan(0);
        expect(
          listing.operations.every((op) => op.method && op.path.startsWith("/"))
        ).toBe(true);

        // The per-operation tool path also parses the real spec into typed operations.
        const operations = await service.operations();
        expect(operations.length, `${id} parsed operations`).toBeGreaterThan(
          min
        );
        expect(
          operations.every(
            (op) => typeof op.id === "string" && op.readOnly === false
          )
        ).toBe(true);
      }
    },
    90_000
  );
});
