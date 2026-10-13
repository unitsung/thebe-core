import { describe, expect, it } from "vitest";
import {
  serviceOperationExposable,
  serviceOperationInputSchema,
  serviceOperationRequest,
  serviceOperationToolName,
  serviceOperationWritable,
  type ServiceAPIOperation,
} from "./service-api.ts";

const readOp: ServiceAPIOperation = {
  id: "findPetsByStatus",
  method: "GET",
  path: "/pet/findByStatus",
  readOnly: true,
  writable: false,
  parameters: [
    { name: "status", in: "query", required: true, schema: { type: "string" } },
    {
      name: "tags",
      in: "query",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  ],
};

const pathOp: ServiceAPIOperation = {
  id: "getPet",
  method: "GET",
  path: "/pet/{petId}",
  readOnly: true,
  writable: false,
  parameters: [
    {
      name: "petId",
      in: "path",
      required: true,
      schema: { type: "integer" },
      description: "Pet id",
    },
  ],
};

const writeOp: ServiceAPIOperation = {
  ...pathOp,
  id: "deletePet",
  method: "DELETE",
  readOnly: false,
  writable: true,
};

const headerOp: ServiceAPIOperation = {
  id: "withHeader",
  method: "GET",
  path: "/secret",
  readOnly: true,
  writable: false,
  parameters: [{ name: "X-Tenant", in: "header", required: true }],
};

describe("service_api per-operation tools", () => {
  it("names a tool from the service and operation id", () => {
    expect(serviceOperationToolName("petstore", "findPetsByStatus")).toBe(
      "service_api.petstore.findPetsByStatus"
    );
    expect(serviceOperationToolName("my service", "GET /a/b")).toBe(
      "service_api.my_service.GET_a_b"
    );
    expect(serviceOperationToolName("svc", "")).toBe(
      "service_api.svc.operation"
    );
  });

  it("exposes only allow-listed read operations without required headers", () => {
    expect(serviceOperationExposable(readOp)).toBe(true);
    expect(serviceOperationExposable(pathOp)).toBe(true);
    expect(serviceOperationExposable(writeOp)).toBe(false);
    expect(serviceOperationExposable(headerOp)).toBe(false);
  });

  it("exposes a write operation only when the operator allow-lists it", () => {
    expect(serviceOperationWritable(writeOp)).toBe(true);
    expect(serviceOperationWritable(readOp)).toBe(false);
    expect(serviceOperationWritable({ ...writeOp, writable: false })).toBe(
      false
    );
    expect(
      serviceOperationWritable({
        ...writeOp,
        parameters: [{ name: "X-Tenant", in: "header", required: true }],
      })
    ).toBe(false);
  });

  it("builds a schema from parameters and an optional body", () => {
    expect(serviceOperationInputSchema(readOp)).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["status"],
    });
    expect(
      serviceOperationInputSchema({
        ...pathOp,
        requestBody: { required: true, schema: { type: "object" } },
      })
    ).toEqual({
      type: "object",
      properties: {
        petId: { type: "integer", description: "Pet id" },
        body: { type: "object" },
      },
      required: ["petId"],
    });
  });

  it("substitutes path parameters and appends query parameters", () => {
    expect(serviceOperationRequest(pathOp, { petId: 7 })).toEqual({
      method: "GET",
      path: "/pet/7",
      readOnly: true,
    });
    expect(
      serviceOperationRequest(readOp, {
        status: "available",
        tags: ["a", "b c"],
      })
    ).toEqual({
      method: "GET",
      path: "/pet/findByStatus?status=available&tags=a&tags=b+c",
      readOnly: true,
    });
  });

  it("passes a body only when the operation declares one", () => {
    expect(
      serviceOperationRequest(
        { ...readOp, requestBody: { required: false } },
        { status: "available", body: { a: 1 } }
      )
    ).toMatchObject({ body: { a: 1 } });
    expect(
      serviceOperationRequest(readOp, { status: "available", body: { a: 1 } })
    ).not.toHaveProperty("body");
  });

  it("rejects a missing required path parameter", () => {
    expect(() => serviceOperationRequest(pathOp, {})).toThrow(
      /path parameter/i
    );
  });
});
