import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import { inferScope, mandateAllows, serviceOfTool } from "./mandate.ts";

const trigger = (kind?: string): Trigger => ({
  id: "t",
  source: "container-health",
  kind: "container.went_down",
  at: "2026-11-06T10:00:00Z",
  threads: ["resource:container:emby"],
  ...(kind ? { resource: { kind, id: "emby" } } : {}),
  payload: {},
});

describe("the scope a Ticket is accepted with", () => {
  it("is inferred from the services the event is about, not from anything the model said", () => {
    expect(inferScope([trigger("container")])).toEqual(["container:write"]);
    expect(inferScope([trigger("container"), trigger("container")])).toEqual([
      "container:write",
    ]);
    expect(inferScope([trigger("download"), trigger("container")])).toEqual([
      "container:write",
      "download:write",
    ]);
    expect(inferScope([trigger()])).toEqual([]);
  });

  it("names the services whose connection says they look after that kind, so any backend will do", () => {
    const servicesFor = (kind: string) =>
      kind === "container" ? ["docker", "arcane"] : [];
    expect(inferScope([trigger("container")], servicesFor)).toEqual([
      "arcane:write",
      "docker:write",
    ]);
    // A kind no connection claims is the service itself.
    expect(inferScope([trigger("download")], servicesFor)).toEqual([
      "download:write",
    ]);
  });
});

describe("which service a call acts on", () => {
  it("is the part of the tool's name before the first dot, or the service a generic service call names", () => {
    expect(serviceOfTool("container_restart")).toBe("container");
    expect(serviceOfTool("navidrome_playlist_update")).toBe("navidrome");
    expect(serviceOfTool("service_write", { service: "radarr" })).toBe(
      "radarr"
    );
    expect(serviceOfTool("service_write", {})).toBeUndefined();
    // No service, so nothing a Mandate could cover.
    expect(serviceOfTool("bash")).toBeUndefined();
    expect(serviceOfTool("edit")).toBeUndefined();
  });
});

describe("what a Mandate covers, call by call", () => {
  const container = { scope: ["container:write"] };

  it("covers any call on a service the scope names, so a new tool on it needs no change here", () => {
    expect(
      mandateAllows(container, "container_restart", { name: "emby" })
    ).toBe(true);
    expect(mandateAllows(container, "container_stop", { name: "emby" })).toBe(
      true
    );
    expect(mandateAllows(container, "container_some_future_write", {})).toBe(
      true
    );
  });

  it("does not cover another service, a tool with no service, or an empty scope", () => {
    expect(mandateAllows(container, "download_add", {})).toBe(false);
    expect(
      mandateAllows(container, "bash", { command: "docker restart emby" })
    ).toBe(false);
    expect(mandateAllows(container, "edit", {})).toBe(false);
    expect(mandateAllows({ scope: [] }, "container_restart", {})).toBe(false);
    expect(mandateAllows({}, "container_restart", {})).toBe(false);
    expect(mandateAllows(undefined, "container_restart", {})).toBe(false);
    expect(
      mandateAllows({ scope: ["download:write"] }, "container_restart", {})
    ).toBe(false);
  });

  it("never covers a call that cannot be undone, judged by that call's own arguments", () => {
    const download = { scope: ["download:write"] };
    expect(
      mandateAllows(download, "download_delete", { deleteFiles: false })
    ).toBe(true);
    expect(
      mandateAllows(download, "download_delete", { deleteFiles: true })
    ).toBe(false);
    expect(
      mandateAllows(
        { scope: ["navidrome:write"] },
        "navidrome_playlist_delete",
        {}
      )
    ).toBe(false);
    expect(
      mandateAllows(
        { scope: ["navidrome:write"] },
        "navidrome_playlist_update",
        {}
      )
    ).toBe(true);
    // A generic service call: covered by the service it names, not when it asks the service to delete data.
    const radarr = { scope: ["radarr:write"] };
    expect(
      mandateAllows(radarr, "service_write", {
        service: "radarr",
        method: "POST",
        path: "/api/v3/movie/1",
      })
    ).toBe(true);
    expect(
      mandateAllows(radarr, "service_write", {
        service: "radarr",
        method: "POST",
        body: { deleteFiles: true },
      })
    ).toBe(false);
    expect(
      mandateAllows(radarr, "service_write", {
        service: "sonarr",
        method: "POST",
      })
    ).toBe(false);
    // The HTTP method is part of the call: a DELETE on a covered service is irreversible, in any case.
    expect(
      mandateAllows(radarr, "service_write", {
        service: "radarr",
        method: "DELETE",
        path: "/api/v3/movie/1",
      })
    ).toBe(false);
    expect(
      mandateAllows(radarr, "service_write", {
        service: "radarr",
        method: "delete",
        path: "/api/v3/movie/1",
      })
    ).toBe(false);
  });
});
