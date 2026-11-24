import { appendFile, cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import type { PipelineProviders } from "../../agent/tools/pipeline-tools.ts";
import { downloadItem } from "../../testing/download-item.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "ok",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
};

const pass = {
  kind: "text" as const,
  text: "VERDICT: pass\nEVIDENCE: checked it\nREMAINING: none",
};

type FakeTurnBatch = Parameters<
  ReturnType<typeof createFakeRuntime>["queueTurns"]
>[0];

const defaultTurns: FakeTurnBatch = [
  { kind: "text", text: "GOAL_STATUS: complete" },
  pass,
];

function open(
  agentStoreDir?: string,
  turns: FakeTurnBatch = defaultTurns,
  now?: () => Date,
  fake = createFakeRuntime(),
  pipeline?: PipelineProviders
) {
  fake.queueTurns(turns);
  const app = createThebeApp({
    runtime: fake.runtime,
    provider,
    agentStoreDir,
    now,
    pipeline,
    workspacePath: pipeline ? process.cwd() : undefined,
    token: pipeline ? "placement-owner" : undefined,
  });
  const call = async (path: string, init?: RequestInit) => {
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(pipeline ? { "x-thebe-token": "placement-owner" } : {}),
          ...init?.headers,
        },
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { app, call, fake };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const placementBenchmark = process.env.THEBE_PLACEMENT_BENCHMARK;
const placementFixtures = [
  "verified",
  "denied",
  "changed",
  "mismatch",
  "crash-after-copy",
  "crash-before-copy",
  "stop-pending",
  "stop-copy",
  "restart-verified",
] as const;
const placementCases = placementFixtures
  .filter(
    (fixture) =>
      !placementBenchmark ||
      ["verified", "mismatch", "crash-after-copy", "stop-copy"].includes(
        fixture
      )
  )
  .flatMap((fixture) =>
    (placementBenchmark ? [1, 2] : [1]).map(
      (executors) => [fixture, executors] as const
    )
  );

describe("tickets", () => {
  it.each(placementCases)(
    "keeps placement intent across restart and records %s with %i Executors",
    async (outcome, executors) => {
      const startedAt = performance.now();
      const dir = await mkdtemp(join(tmpdir(), "thebe-placement-http-"));
      const hash = "a".repeat(40);
      const digest = "b".repeat(64);
      let placed = false;
      let sourceDigest = digest;
      const crashed =
        outcome === "crash-after-copy" ||
        outcome === "crash-before-copy" ||
        outcome === "stop-copy";
      const dispatchReached = signal();
      const finishCopy = signal();
      const copy = vi.fn(async () => {
        placed = outcome !== "crash-before-copy";
        dispatchReached.resolve();
        if (crashed) await finishCopy.promise;
        return { taskIds: ["copy-1"] };
      });
      const pipeline: PipelineProviders = {
        downloads: {
          service: "fixture",
          add: async () => ({ submitted: 1 }),
          list: async () => [],
          get: async () =>
            downloadItem({
              hash,
              name: "Film.mkv",
              state: "completed",
              progress: 1,
            }),
        },
        files: {
          service: "fixture",
          list: async ({ path }) => {
            const entries =
              path === "/incoming" || placed
                ? [
                    {
                      path: `${path}/Film.mkv`,
                      name: "Film.mkv",
                      isDirectory: false,
                      sha256:
                        path === "/incoming"
                          ? sourceDigest
                          : outcome === "mismatch"
                            ? "c".repeat(64)
                            : digest,
                    },
                  ]
                : [];
            return { entries, total: entries.length };
          },
          mkdir: async () => {},
          copy,
          move: async () => ({ taskIds: [] }),
          offlineDownload: async () => ({ taskIds: [] }),
        },
      };
      const first = open(
        dir,
        [
          {
            kind: "tools",
            calls: [
              {
                name: "pipeline_acquire",
                args: {
                  title: "Film",
                  placementApproval: true,
                  magnet: `magnet:?xt=urn:btih:${hash}`,
                  filesSourceDir: "/incoming",
                  libraryDir: "/library",
                },
              },
              {
                name: "goal_report",
                args: {
                  state: "dropped",
                  reason: "The pipeline owns placement.",
                },
              },
            ],
          },
        ],
        undefined,
        undefined,
        pipeline
      );
      let ticketPath = "";
      let attention: Record<string, unknown> = {};
      const skill = await first.call("/v1/skills/media-acquire/content");
      expect(skill.status).toBe(200);
      expect(skill.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
      try {
        const created = await first.call("/v1/tickets", {
          method: "POST",
          body: JSON.stringify({
            task: `Acquire Film using the placement pilot.\n\n${skill.body.content}`,
            idempotencyKey: "placement",
          }),
        });
        expect(created.status).toBe(201);
        ticketPath = `/v1/tickets/${created.body.ticket.id}`;
        await vi.waitFor(() =>
          expect(first.app.agent.listPendingPermissions()).toHaveLength(1)
        );
        const [permission] = first.app.agent.listPendingPermissions();
        const reply = await first.call(`${ticketPath}/reply`, {
          method: "POST",
          body: JSON.stringify({
            permissionId: permission!.id,
            permissionDecision: "allow",
          }),
        });
        expect(reply.status).toBe(200);
        await vi.waitFor(async () => {
          const { body } = await first.call(`${ticketPath}/execution`);
          attention = body.receipt.placementAttention;
          expect(attention).toMatchObject({
            id: expect.any(String),
            source: "/incoming/Film.mkv",
            destination: "/library/Film.mkv",
            state: "pending",
            skill: { name: "media-acquire", digest: skill.body.contentHash },
          });
        });
        expect(copy).toHaveBeenCalledTimes(0);
      } finally {
        await first.app.agent.quiesce();
        await first.fake.runtime.unquiesce();
      }
      const restarted = open(dir, [], undefined, first.fake, pipeline);
      let placementState: string | undefined;
      let secondaryClaim = false;
      try {
        const { body } = await restarted.call(`${ticketPath}/execution`);
        expect(body.receipt.placementAttention).toEqual(attention);
        expect(copy).toHaveBeenCalledTimes(0);
        if (executors === 2) {
          restarted.fake.queueTurns([
            { kind: "text", text: "Placement needs provider evidence." },
          ]);
          const reviewer = await restarted.app.agent.spawnSubagent({
            profileName: "ticket-reviewer",
            background: true,
            parentSessionId: body.ticket.links.legacyGoalId,
            taskPrompt:
              "Check the planned placement independently. Only report success with destination evidence.",
          });
          const checked = await restarted.app.agent.waitSubagent(
            reviewer.runId
          );
          expect(checked.status).toBe("completed");
          secondaryClaim = /placement verified/i.test(checked.result ?? "");
        }
        const decision = (
          placementId: unknown,
          token = "placement-owner",
          placementDecision = "allow"
        ) =>
          restarted.call(`${ticketPath}/reply`, {
            method: "POST",
            headers: { "x-thebe-token": token },
            body: JSON.stringify({ placementId, placementDecision }),
          });
        expect((await decision(attention.id, "wrong-token")).status).toBe(401);
        expect((await decision("stale-id")).status).toBe(409);
        if (outcome === "stop-pending") {
          const stopped = await restarted.call(`${ticketPath}/stop`, {
            method: "POST",
          });
          expect(stopped).toMatchObject({
            status: 200,
            body: { stage: "cancelled" },
          });
          const snapshot = await mkdtemp(
            join(tmpdir(), "thebe-placement-stop-")
          );
          await cp(dir, snapshot, {
            recursive: true,
            filter: (path) => !path.endsWith(".tmp"),
          });
          const recovered = open(snapshot, [], undefined, undefined, pipeline);
          try {
            const reopened = (await recovered.call(`${ticketPath}/execution`))
              .body;
            expect(reopened).toMatchObject({
              stage: "cancelled",
              receipt: {
                placementReport: {
                  id: attention.id,
                  stoppedAt: expect.any(String),
                },
              },
            });
            expect(reopened.ticket.assignments).toHaveLength(1);
            const rejected = await recovered.call(`${ticketPath}/reply`, {
              method: "POST",
              body: JSON.stringify({
                placementId: attention.id,
                placementDecision: "allow",
              }),
            });
            expect(rejected.status).toBe(409);
            expect(copy).not.toHaveBeenCalled();
          } finally {
            await recovered.app.agent.quiesce();
          }
          return;
        }
        if (outcome === "denied") {
          expect(
            (await decision(attention.id, "placement-owner", "deny")).status
          ).toBe(200);
          expect((await decision(attention.id)).status).toBe(409);
          expect(copy).not.toHaveBeenCalled();
          expect(
            (await restarted.call(`${ticketPath}/execution`)).body.receipt
              .placementReport
          ).toMatchObject({
            id: attention.id,
            state: "denied",
            decidedAt: expect.any(String),
            skill: attention.skill,
          });
          return;
        }
        if (outcome === "changed") {
          sourceDigest = "d".repeat(64);
          expect(await decision(attention.id)).toMatchObject({
            status: 409,
            body: { code: "placement_changed" },
          });
          expect(copy).not.toHaveBeenCalled();
          return;
        }
        if (crashed) {
          const inFlight = decision(attention.id);
          try {
            await dispatchReached.promise;
            if (outcome === "stop-copy") {
              const stopped = await restarted.call(`${ticketPath}/stop`, {
                method: "POST",
              });
              expect(stopped).toMatchObject({
                status: 200,
                body: { stage: "cancelled" },
              });
            }
            const snapshot = await mkdtemp(
              join(tmpdir(), "thebe-placement-crash-")
            );
            await cp(dir, snapshot, {
              recursive: true,
              filter: (path) => !path.endsWith(".tmp"),
            });
            const recovered = open(
              snapshot,
              [],
              undefined,
              undefined,
              pipeline
            );
            try {
              const result = (await recovered.call(`${ticketPath}/execution`))
                .body;
              placementState = result.receipt.placementReport?.state;
              expect(result.receipt.placementReport).toMatchObject({
                id: attention.id,
                state: placed ? "verified" : "uncertain",
                dispatchedAt: expect.any(String),
              });
              if (!placed) expect(result.stage).toBe("attention");
              if (outcome === "stop-copy") {
                expect(result).toMatchObject({
                  stage: "cancelled",
                  receipt: {
                    placementReport: { stoppedAt: expect.any(String) },
                  },
                });
              }
              expect(result.ticket.assignments[0]?.id).toBe(
                body.ticket.assignments[0]?.id
              );
              expect(copy).toHaveBeenCalledTimes(1);
              const repeated = await recovered.call(`${ticketPath}/reply`, {
                method: "POST",
                body: JSON.stringify({
                  placementId: attention.id,
                  placementDecision: "allow",
                }),
              });
              expect(repeated.status).toBe(409);
            } finally {
              await recovered.app.agent.quiesce();
            }
          } finally {
            finishCopy.resolve();
            await inFlight;
          }
          return;
        }
        const replies = await Promise.all([
          decision(attention.id),
          decision(attention.id),
        ]);
        expect(replies.map(({ status }) => status).sort()).toEqual([200, 409]);
        expect(copy).toHaveBeenCalledExactlyOnceWith({
          sourceDir: "/incoming",
          destinationDir: "/library",
          names: ["Film.mkv"],
        });
        const result = (await restarted.call(`${ticketPath}/execution`)).body;
        placementState = result.receipt.placementReport?.state;
        expect(result.receipt.placementAttention).toBeUndefined();
        if (outcome === "mismatch") {
          expect(result).toMatchObject({
            stage: "attention",
            receipt: {
              placementReport: {
                id: attention.id,
                state: "uncertain",
                skill: attention.skill,
              },
            },
          });
          expect(result.receipt.placementReport.verifiedAt).toBeUndefined();
          return;
        }
        const verifiedReport = result.receipt.placementReport;
        expect(verifiedReport).toMatchObject({
          id: attention.id,
          state: "verified",
          skill: attention.skill,
          verification: "sha256",
          decidedAt: expect.any(String),
          dispatchedAt: expect.any(String),
          verifiedAt: expect.any(String),
        });
        if (outcome === "restart-verified") {
          const snapshot = await mkdtemp(
            join(tmpdir(), "thebe-placement-verified-")
          );
          await cp(dir, snapshot, {
            recursive: true,
            filter: (path) => !path.endsWith(".tmp"),
          });
          const recovered = open(snapshot, [], undefined, undefined, pipeline);
          try {
            const reopened = (await recovered.call(`${ticketPath}/execution`))
              .body;
            expect(reopened).toMatchObject({
              receipt: { placementReport: verifiedReport },
            });
            expect(reopened.receipt.placementAttention).toBeUndefined();
            expect(reopened.stage).not.toBe("attention");
            expect(reopened.ticket.assignments).toEqual(
              result.ticket.assignments
            );
            expect(copy).toHaveBeenCalledTimes(1);
            const retry = await recovered.call(`${ticketPath}/retry`, {
              method: "POST",
            });
            expect(retry.status).toBe(409);
            expect(copy).toHaveBeenCalledTimes(1);
          } finally {
            await recovered.app.agent.quiesce();
          }
        }
      } finally {
        if (placementBenchmark && placementState) {
          const verified = placementState === "verified";
          const evidence = placed && outcome !== "mismatch";
          const usage = await restarted.app.agent.getBackgroundBudgetSummary();
          const measurement = {
            benchmark: "nas-placement",
            fixture: outcome,
            executors,
            model: "fake/fake-1",
            skillDigest: skill.body.contentHash,
            verifiedSuccess: verified && evidence,
            unsupportedSuccessClaim: (verified || secondaryClaim) && !evidence,
            duplicateMutations: Math.max(0, copy.mock.calls.length - 1),
            elapsedMs: Math.round(performance.now() - startedAt),
            estimatedTokens: usage.usage.counted,
          };
          await appendFile(
            placementBenchmark,
            `${JSON.stringify(measurement)}\n`
          );
        }
        await restarted.app.agent.quiesce();
      }
    }
  );

  it("keeps log cursors usable after older Ticket events rotate out", async () => {
    const { app, call } = open(undefined, [{ kind: "hang" }]);
    try {
      const created = await call("/v1/tickets", {
        method: "POST",
        body: JSON.stringify({
          task: "Check the library",
          idempotencyKey: "log-rotation",
        }),
      });
      const path = `/v1/tickets/${created.body.ticket.id}`;
      for (let index = 0; index < 52; index += 1) {
        const response = await call(`${path}/note`, {
          method: "POST",
          body: JSON.stringify({ note: `Check library ${index}` }),
        });
        expect(response.status).toBe(200);
      }
      const first = (await call(`${path}/log`)).body;
      expect(first.events).toHaveLength(50);
      expect(first.next).toBeGreaterThan(50);
      await call(`${path}/note`, {
        method: "POST",
        body: JSON.stringify({ note: "Check one more library" }),
      });
      const next = (await call(`${path}/log?after=${first.next}`)).body;
      expect(next.events.at(-1)).toMatchObject({ type: "ticket_status" });
      expect(next.next).toBeGreaterThan(first.next);
    } finally {
      await app.agent.quiesce();
    }
  });

  it("reads progress and answers Attention by Ticket ID after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-ticket-execution-"));
    const first = open(dir, [
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "ask",
              question: "Which library should I move?",
            },
          },
        ],
      },
    ]);
    const created = await first.call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "execution-restart",
      }),
    });
    const id = created.body.ticket.id;
    const path = `/v1/tickets/${id}`;
    try {
      await vi.waitFor(async () => {
        const execution = await first.call(`${path}/execution`);
        expect(execution.status).toBe(200);
        expect(execution.body).toMatchObject({
          stage: "attention",
          execution: { iteration: 1, controls: { resume: false, reply: true } },
          receipt: { attention: { question: "Which library should I move?" } },
        });
      });
    } finally {
      await first.app.agent.quiesce();
      await first.fake.runtime.unquiesce();
    }
    const second = open(dir, defaultTurns, undefined, first.fake);
    try {
      const waiting = await second.call(`${path}/execution`);
      const catalogue = await second.call("/v1/tickets?view=execution");
      expect(catalogue.body.tickets).toEqual([waiting.body]);
      const { attention } = waiting.body.receipt;
      expect(attention).toMatchObject({ kind: "answer" });
      const log = await second.call(`${path}/log`);
      expect(log.body.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "ticket_iteration", ticketId: id }),
        ])
      );
      expect(
        log.body.events.every(
          (event: Record<string, unknown>) => !("goalId" in event)
        )
      ).toBe(true);
      const reply = await second.call(`${path}/reply`, {
        method: "POST",
        body: JSON.stringify({ attentionId: attention.id, answer: "Movies" }),
      });
      expect(reply.status).toBe(200);
      await vi.waitFor(async () => {
        const finished = await second.call(`${path}/execution`);
        expect(finished.body).toMatchObject({
          ticket: {
            id,
            assignments: [{ state: "ended", report: { state: "ready" } }],
          },
          stage: "completed",
        });
      });
      const stream = await second.app.handler.handle(
        new Request(`http://127.0.0.1:8787${path}/log?follow=true`)
      );
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      expect(await stream.text()).toContain("event: ticket_completed");
    } finally {
      await second.app.agent.quiesce();
    }
  });

  it("subscribes a direct Ticket to the threads it names", async () => {
    const { call } = open();
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Watch the media servers",
        idempotencyKey: "ticket-threads",
        threads: ["container:emby", { kind: "container", id: "sonarr" }],
      }),
    });
    expect(created.status).toBe(201);
    const ticket = (await call(`/v1/tickets/${created.body.ticket.id}`)).body;
    expect(ticket.subscriptions).toEqual(
      expect.arrayContaining([
        "resource:container:emby",
        "resource:container:sonarr",
      ])
    );
  });

  it("does not serve the retired public Goal API", async () => {
    const { call } = open();
    expect((await call("/v1/goals")).status).toBe(404);
    expect((await call("/v1/goals/abc")).status).toBe(404);
    expect((await call("/v1/session/abc/goal")).status).toBe(404);
    const spec = await call("/openapi.json");
    expect(
      Object.keys(spec.body.paths).filter(
        (path) => path.startsWith("/v1/goals") || path.endsWith("/goal")
      )
    ).toEqual([]);
  });

  it("starts empty, and a Core that has them says so on /v1/health", async () => {
    const { call } = open();
    expect((await call("/v1/tickets")).body).toEqual({ tickets: [] });
    expect((await call("/v1/health")).body.capabilities).toContain("tickets");
  });

  it("documents Ticket reads, reply and Goal controls", async () => {
    const { call } = open();
    const spec = await call("/openapi.json");
    expect(spec.body.paths).toMatchObject({
      "/v1/tickets": {
        get: expect.any(Object),
        post: expect.any(Object),
      },
      "/v1/tickets/{id}": { get: expect.any(Object) },
      "/v1/tickets/{id}/execution": { get: expect.any(Object) },
      "/v1/tickets/{id}/log": { get: expect.any(Object) },
      "/v1/tickets/{id}/reply": { post: expect.any(Object) },
      "/v1/tickets/{id}/note": { post: expect.any(Object) },
      "/v1/tickets/{id}/pause": { post: expect.any(Object) },
      "/v1/tickets/{id}/resume": { post: expect.any(Object) },
      "/v1/tickets/{id}/stop": { post: expect.any(Object) },
      "/v1/tickets/{id}/retry": { post: expect.any(Object) },
    });
    expect(spec.body.components.schemas.Ticket.required).toEqual(
      expect.arrayContaining(["inputs", "origins", "channels"])
    );
    expect(spec.body.components.schemas.TicketInput.properties).toMatchObject({
      actor: { $ref: "#/components/schemas/ActorRef" },
      human: { type: "boolean" },
      channel: { $ref: "#/components/schemas/ChannelRef" },
    });
  });

  it("makes an explicit, direct Ticket for a task the person asks for", async () => {
    const { app, call } = open();
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "direct-library",
        maxIterations: 2,
      }),
    });
    expect(created.status).toBe(201);
    const goalId = created.body.goal.id as string;
    await app.agent.waitGoal(goalId);

    const ticketId = created.body.ticket.id as string;
    expect(ticketId).toMatch(/^[a-f0-9]{32}$/);
    const tickets = (await call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;
    expect(tickets.map((ticket) => ticket.id)).toEqual([ticketId]);
    const ticket = (await call(`/v1/tickets/${ticketId}`)).body;
    expect(ticket).toMatchObject({
      id: ticketId,
      title: "Move the library",
      mandate: { strength: "explicit", decidedBy: "direct", requester: "http" },
      links: { legacyGoalId: goalId, sessionIds: [goalId] },
    });
    // The Ticket does not copy what the Goal owns.
    expect(ticket).not.toHaveProperty("status");
    expect(ticket).not.toHaveProperty("stage");
  });

  it("rejects unsupported Ticket methods and unknown ids", async () => {
    const { call } = open();
    expect(
      (
        await call("/v1/tickets/" + "0".repeat(32), {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(405);
    expect((await call("/v1/tickets/abc", { method: "DELETE" })).status).toBe(
      405
    );
    expect((await call("/v1/tickets/" + "0".repeat(32))).status).toBe(404);
    expect((await call("/v1/tickets/..%2F..%2Fetc")).status).toBe(404);
    expect((await call("/v1/tickets/" + "0".repeat(32) + "/x")).status).toBe(
      404
    );
  });

  it("keeps its Tickets across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-http-"));
    const first = open(dir);
    const created = await first.call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "restart-ticket",
      }),
    });
    await first.app.agent.waitGoal(created.body.goal.id);

    const second = open(dir);
    const tickets = (await second.call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;
    expect(tickets.map((t) => t.id)).toEqual([created.body.ticket.id]);
  });

  it("backfills existing Goals once without changing their Goal identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-tickets-backfill-"));
    const first = open(
      dir,
      defaultTurns,
      () => new Date("2026-11-09T00:00:00.000Z")
    );
    const session = await first.app.agent.createSession({
      title: "Legacy backup task",
    });
    const run = await first.app.agent.startGoal({
      thebeSessionId: session.thebeSessionId,
      goal: "Verify the legacy backup",
    });
    await first.app.agent.waitGoal(run.thebeSessionId);
    expect(await first.app.agent.getTicketForGoal(run.thebeSessionId)).toBe(
      undefined
    );

    const second = open(dir, [], () => new Date("2026-11-10T00:00:00.000Z"));
    const firstRead = (await second.call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;
    const secondRead = (await second.call("/v1/tickets")).body.tickets as Array<
      Record<string, any>
    >;

    expect(firstRead).toHaveLength(1);
    expect(secondRead).toEqual(firstRead);
    expect(firstRead[0]).toMatchObject({
      title: "Verify the legacy backup",
      mandate: {
        strength: "explicit",
        decidedBy: "direct",
        requester: "migration",
      },
      links: {
        legacyGoalId: run.thebeSessionId,
        sessionIds: [run.thebeSessionId],
      },
      createdAt: run.createdAt,
    });
    expect(
      (await second.app.agent.getTicketForGoal(run.thebeSessionId))?.id
    ).toBe(firstRead[0]?.id);
  });

  it("delegates idempotently and replies to the Ticket's attention", async () => {
    const { app, call } = open(undefined, [
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "ask",
              question: "Which library should I move?",
              options: ["Movies", "Shows"],
            },
          },
        ],
      },
    ]);
    const request = {
      task: "Move the selected library",
      idempotencyKey: "http-delegate-library",
      criteria: ["the selected library is in its new location"],
    };
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      reused: false,
      ticket: {
        title: "Move the selected library",
        mandate: {
          strength: "explicit",
          decidedBy: "direct",
          requester: "http",
        },
      },
      stage: "running",
      goal: { status: "running" },
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;

    const retried = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      reused: true,
      ticket: { id: ticketId },
      goal: { id: goalId },
    });

    await vi.waitFor(() => {
      expect(app.agent.getGoal(goalId)?.attention?.kind).toBe("answer");
    });
    const attention = app.agent.getGoal(goalId)?.attention;
    expect(attention).toBeDefined();

    const replied = await call(`/v1/tickets/${ticketId}/reply`, {
      method: "POST",
      body: JSON.stringify({
        attentionId: attention?.id,
        answer: "Movies",
      }),
    });
    expect(replied.status).toBe(200);
    expect(replied.body).toMatchObject({
      ticket: { id: ticketId },
      stage: expect.any(String),
    });
    expect(
      (
        await call(`/v1/tickets/${ticketId}/stop`, {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(200);
  });

  it("pauses and stops a Ticket before its worker has registered", async () => {
    const { app, call } = open(undefined, [{ kind: "hang" }]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Wait for the library scan",
        idempotencyKey: "http-control",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;
    expect(app.agent.getGoal(goalId)?.executor).toBe("ticket");

    const paused = await call(`/v1/tickets/${ticketId}/pause`, {
      method: "POST",
    });
    expect(paused.status).toBe(200);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "paused",
    });
    expect(
      (
        await call(`/v1/tickets/${ticketId}/pause`, {
          method: "POST",
        })
      ).body.code
    ).toBe("invalid_transition");
    const stopped = await call(`/v1/tickets/${ticketId}/stop`, {
      method: "POST",
    });
    expect(stopped.status).toBe(200);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("adds guidance to a live Ticket for its next checkpoint", async () => {
    const { app, call } = open(undefined, [{ kind: "hang" }]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "http-note",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;

    const noted = await call(`/v1/tickets/${ticketId}/note`, {
      method: "POST",
      body: JSON.stringify({ note: "  Put it in Movies.  " }),
    });
    expect(noted.status).toBe(200);
    expect(noted.body).toMatchObject({
      ticket: { id: ticketId },
      stage: "running",
    });
    expect(app.agent.getGoal(goalId)).toMatchObject({
      guidance: ["Put it in Movies."],
    });

    const empty = await call(`/v1/tickets/${ticketId}/note`, {
      method: "POST",
      body: JSON.stringify({ note: " " }),
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("invalid_body");

    await call(`/v1/tickets/${ticketId}/stop`, { method: "POST" });
    await app.agent.waitGoal(goalId);
    const ended = await call(`/v1/tickets/${ticketId}/note`, {
      method: "POST",
      body: JSON.stringify({ note: "Use Movies." }),
    });
    expect(ended.status).toBe(409);
    expect(ended.body.code).toBe("invalid_transition");
  });

  it("resumes a paused Ticket and stops its running Goal", async () => {
    const { app, call, fake } = open(undefined, [{ kind: "hang" }]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Resume the library scan",
        idempotencyKey: "http-control-resume",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;
    await vi.waitFor(() => {
      expect(app.agent.getGoal(goalId)?.activeSubagent).toMatchObject({
        profileName: "ticket-worker",
        status: "running",
      });
    });
    await call(`/v1/tickets/${ticketId}/pause`, { method: "POST" });
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "paused",
    });

    fake.queueTurns([
      { kind: "text", text: "The library scan finished." },
      pass,
    ]);
    const resumed = await call(`/v1/tickets/${ticketId}/resume`, {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(
      (
        await call(`/v1/tickets/${ticketId}/stop`, {
          method: "POST",
        })
      ).body.code
    ).toBe("invalid_transition");

    fake.queueTurns([{ kind: "hang" }]);
    const second = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Wait for the second scan",
        idempotencyKey: "http-control-stop",
      }),
    });
    await vi.waitFor(() => {
      expect(
        app.agent.getGoal(second.body.goal.id as string)?.activeSubagent
          ?.profileName
      ).toBe("ticket-worker");
    });
    const stopped = await call(
      `/v1/tickets/${second.body.ticket.id as string}/stop`,
      { method: "POST" }
    );
    expect(stopped.status).toBe(200);
    await expect(
      app.agent.waitGoal(second.body.goal.id as string)
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("retries blocked work under the same Ticket and Goal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-http-ticket-history-"));
    const { app, call, fake } = open(dir, [
      {
        kind: "tools",
        calls: [
          {
            name: "goal_report",
            args: {
              state: "blocked",
              blocker: "The library is read-only",
            },
          },
        ],
      },
      { kind: "text", text: "Blocked until storage is writable." },
    ]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Move the library",
        idempotencyKey: "http-retry-blocked",
      }),
    });
    const ticketId = created.body.ticket.id as string;
    const goalId = created.body.goal.id as string;
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "failed",
      blocked: true,
    });
    expect(app.agent.getGoal(goalId)?.error).toBe("The library is read-only");

    fake.queueTurns([{ kind: "text", text: "Finished." }, pass]);
    const retried = await call(`/v1/tickets/${ticketId}/retry`, {
      method: "POST",
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      ticket: { id: ticketId },
      stage: "running",
      goal: {
        id: goalId,
        status: "running",
      },
    });
    const completed = await app.agent.waitGoal(goalId);
    expect(completed).toMatchObject({
      status: "completed",
      iteration: 2,
    });
    expect(completed.blocked).toBeUndefined();
    expect(app.agent.getGoal(goalId)?.status).toBe("completed");
    const history = await call(`/v1/tickets/${ticketId}`);
    expect(history.status).toBe(200);
    expect(history.body.assignments).toMatchObject([
      {
        state: "ended",
        report: { state: "blocked", summary: "The library is read-only" },
      },
      { state: "ended", report: { state: "ready" } },
    ]);
    const reopened = await open(dir, []).call(`/v1/tickets/${ticketId}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.assignments).toEqual(history.body.assignments);
  });

  it("refuses retry after completion or a person stop", async () => {
    const { app, call } = open();
    const completed = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Complete once",
        idempotencyKey: "http-retry-completed",
      }),
    });
    await app.agent.waitGoal(completed.body.goal.id);
    const completedRetry = await call(
      `/v1/tickets/${completed.body.ticket.id}/retry`,
      { method: "POST" }
    );
    expect(completedRetry.status).toBe(409);
    expect(completedRetry.body.code).toBe("invalid_transition");

    const stopped = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Stop before finishing",
        idempotencyKey: "http-retry-stopped",
      }),
    });
    const goalId = stopped.body.goal.id as string;
    await call(`/v1/tickets/${stopped.body.ticket.id}/stop`, {
      method: "POST",
    });
    await expect(app.agent.waitGoal(goalId)).resolves.toMatchObject({
      status: "cancelled",
    });
    const stoppedRetry = await call(
      `/v1/tickets/${stopped.body.ticket.id}/retry`,
      { method: "POST" }
    );
    expect(stoppedRetry.status).toBe(409);
    expect(stoppedRetry.body.code).toBe("ticket_stopped");
  });

  it("validates Ticket commands and refuses writes while quiesced", async () => {
    const { app, call } = open();
    const invalid = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({ task: "Inspect the library" }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("invalid_body");

    await app.agent.quiesce();
    const blocked = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Inspect the library",
        idempotencyKey: "quiesced-http",
      }),
    });
    expect(blocked.status).toBe(503);
    const blockedReply = await call(`/v1/tickets/${"0".repeat(32)}/reply`, {
      method: "POST",
      body: JSON.stringify({ attentionId: "attention" }),
    });
    expect(blockedReply.status).toBe(503);
    const blockedNote = await call(`/v1/tickets/${"0".repeat(32)}/note`, {
      method: "POST",
      body: JSON.stringify({ note: "Use Movies." }),
    });
    expect(blockedNote.status).toBe(503);
    const blockedControl = await call(`/v1/tickets/${"0".repeat(32)}/stop`, {
      method: "POST",
    });
    expect(blockedControl.status).toBe(503);
  });

  it("resolves one pending worker permission by Ticket id", async () => {
    const { app, call } = open(undefined, [
      {
        kind: "tools",
        calls: [
          {
            name: "write",
            args: { path: "notes.txt", content: "updated" },
          },
          {
            name: "goal_report",
            args: {
              state: "dropped",
              reason: "nothing else needs changing",
            },
          },
        ],
      },
    ]);
    const created = await call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Update the temporary workspace",
        idempotencyKey: "http-permission",
      }),
    });
    expect(created.status).toBe(201);
    await vi.waitFor(() => {
      expect(app.agent.listPendingPermissions()).toHaveLength(1);
    });
    const pending = app.agent.listPendingPermissions()[0]!;

    const replied = await call(`/v1/tickets/${created.body.ticket.id}/reply`, {
      method: "POST",
      body: JSON.stringify({
        permissionId: pending.id,
        permissionDecision: "allow",
      }),
    });
    expect(replied.status).toBe(200);
    expect(replied.body.pendingPermissions).toEqual([]);
    await expect(
      app.agent.waitGoal(created.body.goal.id)
    ).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("finds an HTTP-delegated Ticket after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-http-delegate-"));
    const first = open(dir);
    const created = await first.call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Inspect the library",
        idempotencyKey: "http-restart",
        observe: true,
      }),
    });
    expect(created.status).toBe(201);
    await first.app.agent.waitGoal(created.body.goal.id);

    const second = open(dir, []);
    const retried = await second.call("/v1/tickets", {
      method: "POST",
      body: JSON.stringify({
        task: "Inspect the library",
        idempotencyKey: "http-restart",
        observe: true,
      }),
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      reused: true,
      ticket: {
        id: created.body.ticket.id,
        assignments: [{ state: "ended", report: { state: "ready" } }],
      },
      goal: { id: created.body.goal.id },
    });
  });
});
