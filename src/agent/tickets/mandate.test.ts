import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import {
  inferScope,
  mandateAllows,
  mandateRefusal,
  revalidateMandate,
  serviceOfTool,
} from "./mandate.ts";

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

describe("revalidating a Ticket before recovery", () => {
  const mandate = {
    decidedBy: "eval" as const,
    requester: "container-health",
    matchedRuleIds: ["rule-1"],
    scope: ["docker:write"],
  };
  const policy = {
    acceptMode: "auto" as const,
    rules: [{ id: "rule-1", text: "Restart a stopped media server." }],
  };
  const valid = {
    mandate,
    subscriptions: ["resource:container:emby"],
    policy,
    servicesForResource: (kind: string) =>
      kind === "container" ? ["docker"] : [],
    enabledSources: ["container-health"],
  };

  it("keeps an inferred Ticket when its Policy, Source and resource wiring still support it", () => {
    expect(revalidateMandate(valid)).toEqual({ allowed: true });
  });

  it("never widens the original scope when resource wiring gains another service", () => {
    expect(
      revalidateMandate({
        ...valid,
        servicesForResource: () => ["arcane", "docker"],
      })
    ).toEqual({ allowed: true });
  });

  it.each([
    {
      name: "automatic acceptance is off",
      change: { policy: { ...policy, acceptMode: "observe" as const } },
      reason: "acceptMode is observe",
    },
    {
      name: "a matched rule was removed",
      change: { policy: { ...policy, rules: [] } },
      reason: "no longer contains matched rule(s) rule-1",
    },
    {
      name: "the Source was disabled",
      change: { enabledSources: [] },
      reason: "container-health Source is not enabled",
    },
    {
      name: "the subscribed resource vanished",
      change: { subscriptions: [] },
      reason: "no resource Thread",
    },
    {
      name: "the service no longer looks after the resource",
      change: { servicesForResource: () => [] },
      reason: "no longer authorizes docker",
    },
  ])("refuses recovery when $name", ({ change, reason }) => {
    expect(revalidateMandate({ ...valid, ...change })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining(reason),
    });
  });

  it("does not make a person's direct Ticket depend on the current Policy", () => {
    expect(
      revalidateMandate({
        ...valid,
        mandate: { ...mandate, decidedBy: "direct" },
        policy: { acceptMode: "off", rules: [] },
        enabledSources: [],
      })
    ).toEqual({ allowed: true });
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

  it("explains a refusal with the tool and the service boundary", () => {
    expect(
      mandateRefusal({ scope: ["download:write"] }, "service_write", {
        service: "radarr",
        method: "POST",
      })
    ).toBe("service_write acts on radarr, outside this Ticket's Mandate.");
    expect(
      mandateRefusal({ scope: ["radarr:write"] }, "service_write", {
        service: "radarr",
        method: "DELETE",
      })
    ).toContain("sends an HTTP DELETE");
    expect(
      mandateRefusal({ scope: ["container:write"] }, "container_restart", {
        name: "emby",
      })
    ).toBeUndefined();
  });
});
