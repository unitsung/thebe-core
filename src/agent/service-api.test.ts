import { describe, expect, it, vi } from "vitest";
import { createThebeAgent } from "./index.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";
import { rememberedDecision, rememberedPermissionKey } from "./security/remembered-permissions.ts";

describe("service API session integration", () => {
  it("pauses an API write, resumes after approval, and observes the resulting task in the same conversation", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "tools", calls: [{ name: "service_api_discover", args: {} }] },
      { kind: "tools", calls: [{ name: "service_api_read", args: { service: "openlist", method: "POST", path: "/api/fs/list", body: { path: "/" } } }] },
      { kind: "tools", calls: [{ name: "service_api_write", args: { service: "openlist", method: "POST", path: "/api/fs/copy", body: { src_dir: "/cloud", dst_dir: "/local", names: ["movie.mkv"] } } }] },
      { kind: "tools", calls: [{ name: "service_api_read", args: { service: "openlist", method: "GET", path: "/api/task/copy/done" } }] },
      { kind: "text", text: "Verified completed task" },
    ]);
    const paths: string[] = [];
    const agent = createThebeAgent({ runtime: fake.runtime,
      provider: { async listContainers() { return []; }, async inspectContainer() { throw new Error("unused"); },
        async getContainerLogs() { return ""; }, async getStatusSummary() { return { totalContainers: 0, runningContainers: 0, pausedContainers: 0, exitedContainers: 0, lastUpdated: 0 }; } },
      serviceAPIProviders: [{ id: "openlist", catalog: () => ({}), async request(input) { paths.push(input.path); return { code: 200, data: [] }; } }],
    });
    const pending = agent.prompt("Download the selected file to local storage and verify the task");
    await vi.waitFor(() => expect(agent.pendingPermissionIds()).toHaveLength(1));
    expect(paths).toEqual(["/api/fs/list"]);
    const permissionId = agent.pendingPermissionIds()[0]!;
    await agent.resolvePermission(agent.lastThebeSessionId()!, permissionId, { response: "allow" });
    expect((await pending).text).toBe("Verified completed task");
    expect(paths).toEqual(["/api/fs/list", "/api/fs/copy", "/api/task/copy/done"]);
  });
  it("keeps coding tools alongside API discovery, gates writes, and rejects direct control-plane writes", async () => {
    const fake = createFakeRuntime();
    const creates: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
    const request = vi.fn().mockResolvedValue({ code: 200, data: [] });
    const agent = createThebeAgent({
      runtime: { ...fake.runtime, async createSession(options) { creates.push(options); return fake.runtime.createSession(options); } },
      provider: { async listContainers() { return []; }, async inspectContainer() { throw new Error("unused"); },
        async getContainerLogs() { return ""; }, async getStatusSummary() { return { totalContainers: 0, runningContainers: 0, pausedContainers: 0, exitedContainers: 0, lastUpdated: 0 }; } },
      serviceAPIProviders: [{ id: "openlist", catalog: async () => ({ documentation: "https://fox.oplist.org/" }), request }],
    });
    await agent.createSession();
    expect(creates[0]!.builtinTools).toEqual(expect.arrayContaining(["bash", "read", "edit", "write"]));
    expect(creates[0]!.customTools.map(tool => tool.name)).toEqual(expect.arrayContaining(["service_api_discover", "service_api_read", "service_api_write"]));
    expect(creates[0]!.toolsRequiringApproval).toContain("service_api_write");
    expect(await agent.listCapabilities()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "service_api_discover", permission: "read" }),
      expect.objectContaining({ name: "service_api_read", permission: "read" }),
      expect.objectContaining({ name: "service_api_write", permission: "confirm" }),
    ]));
    expect(await agent.invokeTool("service_api_discover", {})).toContain("openlist");
    expect(await agent.invokeTool("service_api_discover", {})).toContain("https://fox.oplist.org/");
    await agent.invokeTool("service_api_read", { service: "openlist", method: "POST", path: "/api/fs/list", body: { path: "/" } });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true, body: { path: "/" } }));
    await expect(agent.invokeTool("service_api_write", { service: "openlist", method: "POST", path: "/api/fs/copy" })).rejects.toThrow("runtime approval");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("remembering approval for one API operation does not approve every future operation", () => {
    const copy = { toolName: "service_api_write", args: { service: "openlist", method: "POST", path: "/api/fs/copy", body: { names: ["first"] } } };
    const remove = { toolName: "service_api_write", args: { service: "openlist", method: "POST", path: "/api/fs/remove", body: { names: ["first"] } } };
    const key = rememberedPermissionKey(copy, "allow");
    expect(key).not.toBe("service_api_write");
    expect(rememberedDecision({ [key]: "allow" }, copy)).toBe("allow");
    expect(rememberedDecision({ [key]: "allow" }, remove)).toBeUndefined();
  });
});
