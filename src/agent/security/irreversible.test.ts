import { describe, expect, it } from "vitest";
import { irreversibleReason, irreversibleRefusal } from "./irreversible.ts";

const call = (
  name: string,
  args: Record<string, unknown> = {},
  extra: {
    httpMethod?: string;
    destructiveHint?: boolean;
    operatorMark?: boolean;
  } = {}
) => irreversibleReason({ name, args, ...extra });

describe("irreversibleReason", () => {
  it("judges download_delete by deleteFiles, not by the tool", () => {
    expect(
      call("download_delete", { hashes: ["a"], deleteFiles: true })
    ).toMatch(/files/);
    expect(call("download_delete", { hashes: ["a"], deleteFiles: false })).toBe(
      undefined
    );
  });

  it("always counts a Navidrome playlist delete", () => {
    expect(call("navidrome_playlist_delete", { id: "p1" })).toMatch(/playlist/);
    expect(call("navidrome_playlist_update", { id: "p1" })).toBe(undefined);
  });

  it("counts an HTTP DELETE however the service names it", () => {
    expect(call("service_write", {}, { httpMethod: "delete" })).toMatch(
      /DELETE/
    );
    expect(call("service_write", {}, { httpMethod: "POST" })).toBe(undefined);
  });

  it("counts a delete-style flag in the arguments or the body", () => {
    expect(
      call("service__radarr__updateMovie", { deleteFiles: "true" })
    ).toBeDefined();
    expect(
      call("service_write", { body: { purge: true } }, { httpMethod: "POST" })
    ).toBeDefined();
    expect(call("service__radarr__updateMovie", { purge: false })).toBe(
      undefined
    );
  });

  it("counts a provider tool its server marks destructive", () => {
    expect(
      call("mcp:radarr/delete_movie", {}, { destructiveHint: true })
    ).toMatch(/destructive/);
    expect(call("mcp:radarr/add_movie", {}, { destructiveHint: false })).toBe(
      undefined
    );
  });

  it("lets the operator's mark replace every other rule, in both directions", () => {
    expect(
      call("service__x__y", {}, { httpMethod: "DELETE", operatorMark: false })
    ).toBe(undefined);
    expect(
      call("service__x__y", { purge: true }, { operatorMark: false })
    ).toBe(undefined);
    expect(
      call("service__x__y", {}, { httpMethod: "POST", operatorMark: true })
    ).toMatch(/configuration/);
  });

  it("leaves ordinary writes alone", () => {
    expect(call("container_restart", { id: "c1" })).toBe(undefined);
  });

  it("counts a call that stops or removes what a service runs, however it is named", () => {
    // A tool whose own name says it stops or removes its service's work.
    expect(call("container_stop", { id: "emby" })).toMatch(/stops|removes/);
    // A mutating service call whose path names a destructive action.
    expect(
      call("service_write", {
        service: "arcane",
        method: "POST",
        path: "/api/containers/emby/stop",
      })
    ).toBeDefined();
    expect(
      call("service_write", {
        service: "arcane",
        method: "PUT",
        path: "/api/containers/emby/remove",
      })
    ).toBeDefined();
    // Restarting and starting are how a Ticket does its work.
    expect(
      call("service_write", {
        service: "arcane",
        method: "POST",
        path: "/api/containers/emby/restart",
      })
    ).toBeUndefined();
    // A read that mentions the action is still a read.
    expect(
      call("service_read", { method: "GET", path: "/api/containers/emby/stop" })
    ).toBeUndefined();
    // Holding a download is the recommended way to wait, so a tool doing it stays ordinary.
    expect(call("download_pause", { hashes: ["a"] })).toBeUndefined();
  });

  it("keeps judging download_delete by deleteFiles, not by its name", () => {
    expect(call("download_delete", { hashes: ["a"], deleteFiles: false })).toBe(
      undefined
    );
  });

  it("names the scope that would allow it", () => {
    expect(irreversibleRefusal("x", "deletes a playlist")).toContain(
      "--scope mcp:irreversible"
    );
  });
});
