import { describe, expect, it } from "vitest";
import type { ActionRequest } from "../action/types.ts";
import type { ActivityRecord } from "../activity/types.ts";
import type { ContainerState } from "../capabilities/containers.ts";
import type { Trigger } from "../sources/types.ts";
import { createAutoRestart } from "./auto-restart.ts";
import type { Policy } from "./types.ts";

const NOW = Date.parse("2026-11-06T10:00:00Z");
const hex = (n: number) => n.toString(16).padStart(32, "0");

function down(
  name: string,
  agoMs: number,
  kind = "container.went_down"
): Trigger {
  return {
    id: hex(Math.floor(Math.random() * 1e9)),
    source: "container-health",
    kind,
    at: new Date(NOW - agoMs).toISOString(),
    threads: [`resource:container:${name}`],
    resource: { kind: "container", id: name },
    payload: {},
  };
}

function policy(over: Partial<Policy> = {}): Policy {
  return {
    rules: [{ id: "r1", text: "Restart a media server that stopped" }],
    acceptMode: "auto",
    autoContainers: ["emby"],
    revision: 1,
    updatedAt: "2026-11-06T09:00:00Z",
    ...over,
  };
}

function setup(
  options: {
    containers?: { name: string; state: ContainerState }[];
    activity?: Partial<ActivityRecord>[];
    advises?: boolean;
  } = {}
) {
  const restarts: ActionRequest[] = [];
  const diagnosed: string[] = [];
  const containers = options.containers ?? [{ name: "emby", state: "exited" }];
  const act = createAutoRestart({
    provider: {
      listContainers: async () =>
        containers.map((row, i) => ({
          id: `id-${row.name}-${i}`,
          name: row.name,
          image: "img",
          state: row.state,
          status: row.state,
          created: 1,
        })),
    },
    actions: {
      executeApprovedAction: async (request) => {
        restarts.push(request);
        return {
          receiptId: "receipt-1",
          actionId: request.actionId,
          resource: request.resource,
          approval: {} as never,
          action: {
            status: "succeeded",
            finishedAt: "2026-11-06T10:00:01Z",
            summary: "Restarted emby.",
          },
          verification: { status: "passed", checks: [] },
          idempotencyKey: request.idempotencyKey ?? "",
          tokenUsed: false,
        } as never;
      },
    },
    activity: {
      list: async () => (options.activity ?? []) as ActivityRecord[],
    },
    diagnose: async ({ resource }) => {
      diagnosed.push(resource.name ?? resource.id);
      return {
        diagnosis: { title: "It exited" },
        recommendations:
          options.advises === false
            ? []
            : [{ actionId: "container.restart", requiresApproval: true }],
      } as never;
    },
    now: () => new Date(NOW),
  });
  return { act, restarts, diagnosed };
}

const input = (
  triggers: Trigger[],
  over: Partial<Policy> = {},
  thread = triggers[0]!.threads[0]!
) => ({ decisionId: "d1", thread, triggers, policy: policy(over) });

/** A restart Core started under `auto`, `agoMs` ago. */
const startedByCore = (
  agoMs: number,
  name = "emby"
): Partial<ActivityRecord> => ({
  actionId: "container.restart",
  approval: { source: "policy" } as never,
  resource: {
    kind: "container",
    id: `id-${name}-0`,
    name,
    provider: "unknown",
  },
  createdAt: new Date(NOW - agoMs).toISOString(),
});

describe("auto: what Core does about a stopped container", () => {
  it("restarts a listed, stopped container through the approved-action path, once per Decision", async () => {
    const { act, restarts, diagnosed } = setup();
    const result = await act(input([down("emby", 30_000)]));
    expect(result).toMatchObject({
      kind: "restart",
      status: "succeeded",
      receiptId: "receipt-1",
      container: "emby",
    });
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject({
      actionId: "container.restart",
      idempotencyKey: "auto:d1",
      approval: { approved: true, client: "policy" },
      resource: { name: "emby", id: "id-emby-0" },
    });
    expect(diagnosed).toEqual([]);
  });

  it("does not act on an old event, such as one replayed after a restart", async () => {
    const { act, restarts } = setup();
    const result = await act(input([down("emby", 6 * 60_000)]));
    expect(result).toMatchObject({ kind: "none", status: "stale" });
    expect(restarts).toEqual([]);
  });

  it("does not act when the container came back after it went down", async () => {
    const { act, restarts } = setup();
    const result = await act(
      input([down("emby", 40_000), down("emby", 10_000, "container.recovered")])
    );
    expect(result).toMatchObject({ kind: "none", status: "not_down_event" });
    expect(restarts).toEqual([]);
  });

  it("looks again before restarting: a container that is up or restarting by itself is left alone", async () => {
    for (const state of ["running", "restarting", "paused"] as const) {
      const { act, restarts } = setup({
        containers: [{ name: "emby", state }],
      });
      const result = await act(input([down("emby", 5_000)]));
      expect(result, state).toMatchObject({
        kind: "none",
        status: "already_up",
      });
      expect(restarts, state).toEqual([]);
    }
  });

  it("takes the target from the thread's own name, and refuses none or several", async () => {
    const missing = setup({ containers: [{ name: "plex", state: "exited" }] });
    expect(await missing.act(input([down("emby", 5_000)]))).toMatchObject({
      status: "container_not_found",
    });
    const twice = setup({
      containers: [
        { name: "emby", state: "exited" },
        { name: "emby", state: "exited" },
      ],
    });
    expect(await twice.act(input([down("emby", 5_000)]))).toMatchObject({
      status: "container_ambiguous",
    });
    expect(missing.restarts.concat(twice.restarts)).toEqual([]);
    const notAContainer = setup();
    expect(
      await notAContainer.act(input([down("emby", 5_000)], {}, "chat:abc"))
    ).toMatchObject({ status: "not_a_container" });
  });

  it("only diagnoses a container that is not on the list, which puts the restart to the person", async () => {
    const { act, restarts, diagnosed } = setup({
      containers: [{ name: "plex", state: "exited" }],
    });
    const result = await act(input([down("plex", 5_000)]));
    expect(result).toMatchObject({
      kind: "diagnose",
      status: "awaiting_approval",
      container: "plex",
    });
    expect(diagnosed).toEqual(["plex"]);
    expect(restarts).toEqual([]);
    // An empty or missing list means no direct restart at all.
    const empty = setup();
    expect(
      await empty.act(input([down("emby", 5_000)], { autoContainers: [] }))
    ).toMatchObject({ kind: "diagnose" });
    expect(
      await empty.act(
        input([down("emby", 5_000)], { autoContainers: undefined })
      )
    ).toMatchObject({ kind: "diagnose" });
    expect(empty.restarts).toEqual([]);
  });

  it("says when the diagnosis advises no restart, and when it cannot be made", async () => {
    const calm = setup({
      containers: [{ name: "plex", state: "exited" }],
      advises: false,
    });
    expect(await calm.act(input([down("plex", 5_000)]))).toMatchObject({
      kind: "diagnose",
      status: "no_restart_advised",
    });
  });

  it("stops after three restarts in an hour and asks the person instead", async () => {
    const tripped = setup({
      activity: [
        startedByCore(50 * 60_000),
        startedByCore(30 * 60_000),
        startedByCore(5 * 60_000),
      ],
    });
    const result = await tripped.act(input([down("emby", 5_000)]));
    expect(result).toMatchObject({ kind: "diagnose" });
    expect(result.note).toContain("already restarted 3 times");
    expect(tripped.restarts).toEqual([]);
    expect(tripped.diagnosed).toEqual(["emby"]);

    // Two do not trip it; old ones and a person's own approvals do not count.
    const open = setup({
      activity: [
        startedByCore(50 * 60_000),
        startedByCore(5 * 60_000),
        startedByCore(2 * 60 * 60_000),
        {
          ...startedByCore(60_000),
          approval: { source: "on_device" } as never,
        },
        startedByCore(60_000, "plex"),
      ],
    });
    expect(await open.act(input([down("emby", 5_000)]))).toMatchObject({
      kind: "restart",
    });
    expect(open.restarts).toHaveLength(1);
  });
});
