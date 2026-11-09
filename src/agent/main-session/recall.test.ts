import { describe, expect, it } from "vitest";
import type { RuntimeMessage } from "../runtime/interface.ts";
import type { AgentSessionMeta } from "../store.ts";
import {
  createSessionSearchTool,
  runSessionSearch,
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

  it("falls back to any matching keyword and skips internal assessment Sessions", async () => {
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
      ])
    );
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
