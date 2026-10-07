import { describe, expect, it, vi } from "vitest";
import { OpenAPIService } from "./openapi.ts";
import { redactToolOutput } from "../../agent/security/redaction.ts";

function spec(paths: Record<string, unknown>) {
  return { openapi: "3.1.1", info: { title: "An arbitrary service", version: "1" },
    servers: [{ url: "https://untrusted.invalid" }], paths,
    components: { schemas: { Job: { type: "object", properties: { name: { type: "string" } } } } } };
}
const paths = { "/jobs": { post: { operationId: "createJob", summary: "Create a scheduled job", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } } } },
  "/jobs/{id}": { parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], get: { operationId: "getJob", summary: "Read job status" } } };

describe("dynamic OpenAPI service capability", () => {
  it("discovers previously unknown operations and loads their input schemas without implementation-specific tools", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(spec(paths))));
    const provider = new OpenAPIService({ id: "scheduler", baseURL: "https://service.invalid", openapiPath: "/spec.json", headers: { "X-API-Key": "private-key" } }, transport);
    const listing = await provider.catalog({ query: "scheduled" }) as { operations: { id: string }[] };
    expect(listing.operations.map(op => op.id)).toEqual(["createJob"]);
    const detail = JSON.stringify(await provider.catalog({ operationId: "createJob" }));
    expect(detail).toContain('"name":{"type":"string"}');
    expect(detail).not.toContain("private-key");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("uses refreshed schema data to discover an added operation without adding code or a tool definition", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(spec(paths))))
      .mockResolvedValueOnce(new Response(JSON.stringify(spec({ ...paths, "/bulk-export": { post: { operationId: "newBulkExport", summary: "Export all results" } } }))))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "export-1" })));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid", openapiPath: "/spec.json" }, transport);
    expect(JSON.stringify(await provider.catalog())).not.toContain("newBulkExport");
    expect(JSON.stringify(await provider.catalog({ refresh: true, query: "export" }))).toContain("newBulkExport");
    expect(await provider.request({ method: "POST", path: "/bulk-export", body: { target: "selected" }, readOnly: false })).toMatchObject({ ok: true, body: { jobId: "export-1" } });
    expect(transport.mock.calls.at(-1)![0]).toBe("https://service.invalid/bulk-export");
  });
  it("does not let a remote schema mark mutating GET operations read-only or redirect credential-bearing requests", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(spec({ "/delete-all": { get: { operationId: "deleteAll", "x-read-only": true } } }))));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid/prefix", openapiPath: "/spec.json", headers: { Authorization: "secret" } }, transport);
    await expect(provider.request({ method: "GET", path: "/delete-all", readOnly: true })).rejects.toThrow("approval");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("https://service.invalid/prefix/spec.json");
    expect(transport.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
  it("supports a configured read operation with path parameters", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(spec(paths))))
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "done" })));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid", openapiPath: "/spec.json", readOperations: ["getJob"] }, transport);
    expect(await provider.request({ method: "GET", path: "/jobs/123", readOnly: true })).toMatchObject({ ok: true, body: { state: "done" } });
  });
  it("does not treat a concrete mutating route as a trusted parameterized read", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(spec({ ...paths,
      "/jobs/remove-all": { get: { operationId: "removeAllJobs" } } }))));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid", openapiPath: "/spec.json", readOperations: ["getJob"] }, transport);
    await expect(provider.request({ method: "GET", path: "/jobs/remove-all", readOnly: true })).rejects.toThrow("approval");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("discovers and calls custom methods supplied by OpenAPI additionalOperations", async () => {
    const document = { ...spec({ "/files/{id}": { additionalOperations: { COPY: { operationId: "copyFile" } } } }), openapi: "3.2.1" };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(document)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ copied: true })));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid", openapiPath: "/spec.json" }, transport);
    expect(JSON.stringify(await provider.catalog({ operationId: "copyFile" }))).toContain('"method":"COPY"');
    expect(await provider.request({ method: "COPY", path: "/files/1", readOnly: false })).toMatchObject({ ok: true, body: { copied: true } });
  });
  it.each(["https://evil.invalid/tasks", "//evil.invalid/tasks", "/a/../tasks", "/a/%2e%2e/tasks", "/a/%252e%252e/tasks", "/a/%2f%2fevil", "/jobs/x%2fdelete", "/a#fragment"])("rejects host/path escapes %s", async path => {
    const transport = vi.fn<typeof fetch>();
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid" }, transport);
    await expect(provider.request({ method: "POST", path, readOnly: false })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("reuses arbitrary private response values across requests without exposing them or hardcoding a transfer workflow", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: { token: "transient-private-token", files: [{ id: "first", shareFidToken: "private-file-value" }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ submitted: true })));
    const provider = new OpenAPIService({ id: "new-cloud", baseURL: "https://service.invalid" }, transport);
    const result = await provider.request({ method: "GET", path: "/share/inspect", readOnly: false }) as { privateValueReferences: { pointer: string; reference: string }[] };
    const visible = redactToolOutput(JSON.stringify(result));
    expect(visible).not.toContain("transient-private-token");
    expect(visible).not.toContain("private-file-value");
    expect(JSON.parse(visible).privateValueReferences).toHaveLength(2);
    const token = result.privateValueReferences.find(ref => ref.pointer === "/data/token")!.reference;
    const file = result.privateValueReferences.find(ref => ref.pointer.endsWith("/shareFidToken"))!.reference;
    await provider.request({ method: "POST", path: "/totally-new-save-endpoint", readOnly: false,
      body: { receiveCode: { $thebeValueRef: token }, fidTokens: [{ $thebeValueRef: file }], fids: ["first"] } });
    expect(transport.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ receiveCode: "transient-private-token", fidTokens: ["private-file-value"], fids: ["first"] }) });
  });
  it("permits approved requests when a service has no schema and exposes a non-success HTTP response as failed", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ message: "missing" }), { status: 404 }));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid" }, transport);
    await expect(provider.catalog()).rejects.toThrow("No JSON OpenAPI");
    expect(await provider.request({ method: "POST", path: "/operation-from-documentation", readOnly: false })).toMatchObject({ ok: false, status: 404 });
  });
  it("supports text/form requests and isolates private value references between connections", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response("accepted"));
    const provider = new OpenAPIService({ id: "anything", baseURL: "https://service.invalid" }, transport);
    expect(await provider.request({ method: "POST", path: "/login-check", contentType: "application/x-www-form-urlencoded", body: "selected=yes", readOnly: false })).toMatchObject({ ok: true, body: "accepted" });
    await expect(provider.request({ method: "POST", path: "/save", body: { value: { $thebeValueRef: "unknown" } }, readOnly: false })).rejects.toThrow("different service");
  });
});
