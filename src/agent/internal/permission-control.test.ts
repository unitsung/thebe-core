import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "../runtime/interface.ts";
import { mandateAllows } from "../tickets/mandate.ts";

const RESTART = "container_restart";
import type { TicketMandate } from "../tickets/types.ts";
import { createPermissionControl } from "./permission-control.ts";

const request = (toolName: string): PermissionRequest => ({
  permissionId: "p1",
  toolName,
  toolCallId: "c1",
  args: { name: "emby" },
});

function control(
  mandates: Record<string, Pick<TicketMandate, "scope">>,
  unattended: string[] = []
) {
  return createPermissionControl({
    initialMode: "manual",
    // The workspace policy asks about every tool that is not a read in the workspace.
    preflight: async () => "ask" as const,
    workspaceReadTools: ["read", "ls", "find", "grep"],
    lookupRemembered: async () => undefined,
    active: () => undefined,
    openedSessions: new Map(),
    lookup: async () => {
      throw new Error("unused");
    },
    persist: async () => {},
    touchMeta: (meta) => meta,
    mandateAllows: async (sessionId, req) =>
      mandateAllows(mandates[sessionId] as never, req.toolName, req.args),
    unattended: async (sessionId) => unattended.includes(sessionId),
  });
}

describe("a write inside a Ticket's Mandate", () => {
  const covered = { scope: ["container:write"] };

  it("is allowed without asking, in the session of the Ticket that covers it", async () => {
    const permissions = control({ goal1: covered });
    const handler = permissions.permissionHandler("goal1");
    expect(await handler.preflight(request(RESTART))).toBe("allow");
  });

  it("is asked about, or refused at once when nobody is there, in a session whose Ticket does not cover it", async () => {
    const permissions = control({
      goal1: covered,
      goal2: { scope: [] },
      goal3: { scope: ["download:write"] },
    });
    // No Ticket at all: an ordinary session asks the person.
    expect(
      await permissions.permissionHandler("chat").preflight(request(RESTART))
    ).toBe("ask");
    expect(
      await permissions.permissionHandler("goal2").preflight(request(RESTART))
    ).toBe("ask");
    expect(
      await permissions.permissionHandler("goal3").preflight(request(RESTART))
    ).toBe("ask");
    // An unattended run does not wait for an answer that will not come: it is refused, so the work fails fast.
    permissions.nonInteractiveRuns.add("goal2");
    expect(
      await permissions.permissionHandler("goal2").preflight(request(RESTART))
    ).toBe("deny");
  });

  it("covers any call on the service the scope names, and nothing on another service, without a service, or irreversible", async () => {
    const permissions = control({ goal1: covered });
    const handler = permissions.permissionHandler("goal1");
    const ask = (toolName: string, args: unknown = {}) =>
      handler.preflight({ ...request(toolName), args });
    expect(await ask("container_stop", { name: "emby" })).toBe("allow");
    for (const tool of [
      "bash",
      "edit",
      "write",
      "download_add",
      "navidrome_playlist_update",
    ]) {
      expect(await ask(tool), tool).toBe("ask");
    }
    const downloads = control({
      goal1: { scope: ["download:write"] },
    }).permissionHandler("goal1");
    expect(
      await downloads.preflight({
        ...request("download_delete"),
        args: { deleteFiles: false },
      })
    ).toBe("allow");
    expect(
      await downloads.preflight({
        ...request("download_delete"),
        args: { deleteFiles: true },
      })
    ).toBe("ask");
  });

  it("refuses at once, rather than waiting, what the Ticket of an unattended session does not cover", async () => {
    // A Ticket Eval accepted on its own has nobody watching it: not even a nonInteractive flag is needed.
    const permissions = control({ goal1: covered }, ["goal1"]);
    const handler = permissions.permissionHandler("goal1");
    expect(await handler.preflight(request(RESTART))).toBe("allow");
    expect(await handler.preflight(request("bash"))).toBe("deny");
    expect(await handler.request({ ...request("bash") })).toBe("deny");
    // A person's own session still gets asked.
    expect(
      await control({ goal1: covered })
        .permissionHandler("goal1")
        .preflight(request("bash"))
    ).toBe("ask");
  });

  it("does not turn an unattended run's refusal of everything else into a yes", async () => {
    const permissions = control({ goal1: covered });
    permissions.nonInteractiveRuns.add("goal1");
    const handler = permissions.permissionHandler("goal1");
    expect(await handler.preflight(request("bash"))).toBe("deny");
    expect(await handler.preflight(request(RESTART))).toBe("allow");
  });
});
