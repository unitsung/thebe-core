import { describe, expect, it } from "vitest";
import type { RuntimeMessage } from "../runtime/interface.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { AgentArtifact, ArtifactQuery } from "../artifacts/types.ts";
import type { TicketTaskView } from "../tickets/control.ts";
import type { Ticket } from "../tickets/types.ts";
import {
  createRecallTool,
  createSessionSearchTool,
  runRecall,
  runSessionSearch,
  type RecallDependencies,
  type SessionSearchDependencies,
} from "./recall.ts";

function session(
  id: string,
  title: string,
  activeAt: string,
  messages: RuntimeMessage[],
  extra: Partial<AgentSessionMeta> = {}
): AgentSessionMeta {
  return {
    thebeSessionId: id,
    runtimeId: "fake",
    runtimeSessionId: `runtime-${id}`,
    title,
    lastActiveAt: activeAt,
    messageCount: messages.length,
    ...extra,
  };
}

function message(role: RuntimeMessage["role"], text: string): RuntimeMessage {
  return { id: `${role}-${text}`, role, text };
}

function harness() {
  const backupMessages = [
    message("user", "How should nightly backups run?"),
    message("assistant", "Use restic with a seven-day retention."),
    message("tool", "tool transcript is not spoken history"),
    message("assistant", "Keep the repository on the NAS."),
  ];
  const mediaMessages = [
    message("user", "Find the last movie we discussed."),
    message("assistant", "We discussed Arrival."),
  ];
  const diagnosisMessages = [
    message("assistant", "restic diagnosis internal evidence"),
  ];
  const sessions = [
    session("thebe-main", "Thebe", "2026-11-10T04:00:00Z", []),
    session("backup", "Backup plan", "2026-11-09T04:00:00Z", backupMessages),
    session("media", "Movie night", "2026-11-08T04:00:00Z", mediaMessages),
    session(
      "assessment",
      "Eval assessment",
      "2026-11-10T02:00:00Z",
      [message("assistant", "restic internal assessment")],
      { labels: { purpose: "eval-assessment" } }
    ),
    session(
      "diagnosis",
      "Container diagnosis",
      "2026-11-10T03:00:00Z",
      diagnosisMessages,
      { labels: { purpose: "container-diagnosis" } }
    ),
  ];
  const messages = new Map(
    sessions.map((row) => [row.thebeSessionId, messagesFor(row)])
  );
  const dependencies: SessionSearchDependencies = {
    currentSessionId: "thebe-main",
    listSessions: async () => sessions,
    readMessages: async (id) =>
      messages.get(id) ?? Promise.reject(new Error("missing")),
  };
  return { dependencies };

  function messagesFor(row: AgentSessionMeta): RuntimeMessage[] {
    if (row.thebeSessionId === "backup") return backupMessages;
    if (row.thebeSessionId === "media") return mediaMessages;
    if (row.thebeSessionId === "diagnosis") return diagnosisMessages;
    return [];
  }
}

describe("main Session recall", () => {
  it("searches person-facing Sessions and excludes the current main Session", async () => {
    const { dependencies } = harness();

    const result = await runSessionSearch(
      { query: "restic retention" },
      dependencies
    );

    expect(result).toMatchObject({
      mode: "search",
      matched: "all",
      count: 1,
      results: [
        {
          sessionId: "backup",
          title: "Backup plan",
          snippets: [
            {
              n: 2,
              role: "assistant",
              text: "Use restic with a seven-day retention.",
            },
          ],
        },
      ],
    });
  });

  it("falls back to any matching keyword and skips internal workflow Sessions", async () => {
    const { dependencies } = harness();

    const result = await runSessionSearch(
      { query: "restic Arrival" },
      dependencies
    );

    expect(result.matched).toBe("any");
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "backup" }),
        expect.objectContaining({ sessionId: "media" }),
      ])
    );
    expect(result.results).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "assessment" }),
        expect.objectContaining({ sessionId: "diagnosis" }),
      ])
    );
    await expect(
      runSessionSearch({ sessionId: "diagnosis" }, dependencies)
    ).rejects.toThrow("person-facing");
  });

  it("reads a bounded window around a numbered message", async () => {
    const { dependencies } = harness();

    const result = await runSessionSearch(
      { sessionId: "backup", around: 2, window: 1 },
      dependencies
    );

    expect(result).toMatchObject({
      mode: "read",
      sessionId: "backup",
      title: "Backup plan",
      from: 1,
      to: 3,
      hasEarlier: false,
      hasLater: true,
      messages: [
        { n: 1, role: "user" },
        { n: 2, role: "assistant" },
      ],
    });
  });

  it("browses recent Sessions and exposes the tool as read-only", async () => {
    const { dependencies } = harness();
    const tool = createSessionSearchTool(dependencies);

    const result = await runSessionSearch({}, dependencies);

    expect(tool.requiresApproval).not.toBe(true);
    expect(result).toMatchObject({
      mode: "browse",
      count: 2,
      results: [{ sessionId: "backup" }, { sessionId: "media" }],
    });
  });

  it("refuses to read the current main Session", async () => {
    const { dependencies } = harness();

    await expect(
      runSessionSearch({ sessionId: "thebe-main" }, dependencies)
    ).rejects.toThrow("current main Session");
  });
});

const TICKET_ID = "a".repeat(32);
const GOAL_ID = "goal-backup";
const ARTIFACT_ID = "artifact-backup-report";

function ticketView(): TicketTaskView {
  const ticket: Ticket = {
    id: TICKET_ID,
    title: "Nightly backup",
    mandate: {
      strength: "explicit",
      decidedBy: "direct",
      evalId: "direct-eval",
      requester: "chat",
    },
    subscriptions: ["chat:goal-backup", "resource:container:backup-agent"],
    inputs: [],
    origins: [],
    channels: [],
    links: {
      legacyGoalId: GOAL_ID,
      decisionId: "decision-backup",
      requestId: "request-backup",
      sessionIds: [GOAL_ID],
    },
    createdAt: "2026-11-09T04:00:00.000Z",
  };
  return {
    ticket,
    stage: "completed",
    goal: {
      id: GOAL_ID,
      title: "Nightly backup",
      sessionId: GOAL_ID,
      status: "succeeded",
      phase: "completed",
      iteration: 1,
      maxIterations: 2,
      progress: 1,
      createdAt: "2026-11-09T04:00:00.000Z",
      updatedAt: "2026-11-09T04:05:00.000Z",
      controls: {
        pause: false,
        resume: false,
        stop: false,
      },
      finalReport: "TOOL_LOG_SECRET should never be recalled",
    },
    pendingPermissions: [],
    receipt: {
      state: "completed",
      complete: true,
      summary: "Backup verified",
      report: {
        state: "ready",
        summary: "Backup verified",
        evidence: "TOOL_LOG_SECRET is verifier evidence",
        at: "2026-11-09T04:05:00.000Z",
      },
      finalReport: "TOOL_LOG_SECRET should never be recalled",
      artifactId: ARTIFACT_ID,
    },
  };
}

function artifact(): AgentArtifact {
  return {
    artifactId: ARTIFACT_ID,
    kind: "report",
    title: "Nightly backup report",
    sessionId: GOAL_ID,
    runId: GOAL_ID,
    resource: { kind: "container", id: "backup-agent" },
    createdAt: "2026-11-09T04:05:00.000Z",
    updatedAt: "2026-11-09T04:05:00.000Z",
    contentType: "text/plain; charset=utf-8",
    sizeBytes: 123,
  };
}

function recallHarness() {
  const tickets = [ticketView()];
  const artifacts = [artifact()];
  const sessions = [
    session(
      GOAL_ID,
      "Nightly backup",
      "2026-11-09T04:05:00.000Z",
      [message("user", "TOOL_LOG_SECRET transcript text")],
      {
        goalRun: {
          thebeSessionId: GOAL_ID,
          goal: "Verify the nightly backup",
          maxIterations: 2,
          iteration: 1,
          status: "completed",
          createdAt: "2026-11-09T04:00:00.000Z",
          subagentRunIds: [],
        },
      }
    ),
  ];
  const dependencies: RecallDependencies = {
    tickets: {
      get: async (id) => tickets.find((row) => row.ticket.id === id),
      related: async (query) => {
        const sessionIds = new Set(query.sessionIds ?? []);
        const decisionIds = new Set(query.decisionIds ?? []);
        const artifactIds = new Set(query.artifactIds ?? []);
        const subscriptions = new Set(query.subscriptions ?? []);
        return tickets.filter(
          (view) =>
            [...view.ticket.links.sessionIds, view.ticket.links.legacyGoalId]
              .filter((id): id is string => id !== undefined)
              .some((id) => sessionIds.has(id)) ||
            (view.ticket.links.decisionId !== undefined &&
              decisionIds.has(view.ticket.links.decisionId)) ||
            (view.receipt.artifactId !== undefined &&
              artifactIds.has(view.receipt.artifactId)) ||
            view.ticket.subscriptions.some((thread) =>
              subscriptions.has(thread)
            )
        );
      },
    },
    artifacts: {
      get: async (id) => artifacts.find((row) => row.artifactId === id),
      list: async (query: ArtifactQuery = {}) =>
        artifacts
          .filter(
            (row) =>
              query.sessionId === undefined || row.sessionId === query.sessionId
          )
          .slice(0, query.limit ?? 100),
    },
    sessions: {
      listSessions: async () => sessions,
      getSession: async (id) => ({
        ...sessions.find((row) => row.thebeSessionId === id)!,
        status: "idle",
        streaming: false,
      }),
    },
  };
  return { dependencies };
}

describe("typed recall references", () => {
  it("returns a Ticket summary, state and related ids without its transcript or report text", async () => {
    const { dependencies } = recallHarness();

    const result = await runRecall(
      { kind: "ticket", id: TICKET_ID },
      dependencies
    );

    expect(result).toMatchObject({
      found: true,
      reference: `ticket:${TICKET_ID}`,
      summary: "Nightly backup: Backup verified",
      state: "completed",
      ids: {
        ticketId: TICKET_ID,
        goalId: GOAL_ID,
        decisionId: "decision-backup",
        sessionIds: [GOAL_ID],
        artifactIds: [ARTIFACT_ID],
        resources: [{ kind: "container", id: "backup-agent" }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("TOOL_LOG_SECRET");
  });

  it("returns Artifact metadata and linked ids without Artifact content", async () => {
    const { dependencies } = recallHarness();
    dependencies.artifacts.list = async () => {
      throw new Error("Artifact recall must load an exact reference by id");
    };

    const result = await runRecall(
      { kind: "artifact", id: ARTIFACT_ID },
      dependencies
    );

    expect(result).toMatchObject({
      found: true,
      reference: `artifact:${ARTIFACT_ID}`,
      summary: "Nightly backup report",
      state: "report",
      ids: {
        artifactId: ARTIFACT_ID,
        ticketIds: [TICKET_ID],
        sessionId: GOAL_ID,
        runId: GOAL_ID,
        resource: { kind: "container", id: "backup-agent" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("TOOL_LOG_SECRET");
  });

  it("finds a resource through related Tickets and Artifacts", async () => {
    const { dependencies } = recallHarness();

    const result = await runRecall(
      {
        kind: "resource",
        resourceKind: "container",
        id: "backup-agent",
      },
      dependencies
    );

    expect(result).toMatchObject({
      found: true,
      reference: "resource:container:backup-agent",
      state: {
        tickets: [{ ticketId: TICKET_ID, stage: "completed" }],
        artifacts: [{ artifactId: ARTIFACT_ID, kind: "report" }],
      },
      ids: {
        resource: { kind: "container", id: "backup-agent" },
        ticketIds: [TICKET_ID],
        artifactIds: [ARTIFACT_ID],
        sessionIds: [GOAL_ID],
      },
    });
  });

  it("returns Session metadata and links but never its message text", async () => {
    const { dependencies } = recallHarness();

    const result = await runRecall(
      { kind: "session", id: GOAL_ID },
      dependencies
    );

    expect(result).toMatchObject({
      found: true,
      reference: `session:${GOAL_ID}`,
      summary: "Nightly backup, 1 message(s)",
      state: "idle",
      ids: {
        sessionId: GOAL_ID,
        goalId: GOAL_ID,
        ticketIds: [TICKET_ID],
        artifactIds: [ARTIFACT_ID],
      },
    });
    expect(JSON.stringify(result)).not.toContain("TOOL_LOG_SECRET");
  });

  it("returns a clear not-found result for an unknown exact reference", async () => {
    const { dependencies } = recallHarness();

    await expect(
      runRecall({ kind: "ticket", id: "b".repeat(32) }, dependencies)
    ).resolves.toEqual({
      found: false,
      reference: `ticket:${"b".repeat(32)}`,
      error: "No ticket matches this exact reference.",
    });
    await expect(
      runRecall({ kind: "artifact", id: "../missing" }, dependencies)
    ).resolves.toEqual({
      found: false,
      reference: "artifact:../missing",
      error: "No artifact matches this exact reference.",
    });
  });

  it("exposes recall as a read-only tool and validates resource references", async () => {
    const { dependencies } = recallHarness();
    const tool = createRecallTool(dependencies);

    expect(tool.name).toBe("recall");
    expect(tool.requiresApproval).not.toBe(true);
    await expect(
      runRecall({ kind: "resource", id: "backup-agent" }, dependencies)
    ).rejects.toThrow("resourceKind");
  });
});
