import { describe, expect, it } from "vitest";
import {
  SearchableSessionPicker,
  type ProductSessionRow,
} from "./session-picker.ts";

const sampleSessions: ProductSessionRow[] = [
  {
    thebeSessionId: "session-11111111",
    runtimeSessionId: "rt-1",
    title: "Docker container inspection",
    status: "active",
    lastActiveAt: "2026-09-08T12:00:00Z",
  },
  {
    thebeSessionId: "session-22222222",
    runtimeSessionId: "rt-2",
    title: "Muse spark benchmark",
    status: "idle",
    lastActiveAt: "2026-09-08T11:00:00Z",
  },
  {
    thebeSessionId: "session-33333333",
    runtimeSessionId: "rt-3",
    parentThebeSessionId: "session-22222222",
    title: "Branch test run",
    status: "done",
    lastActiveAt: "2026-09-08T10:00:00Z",
  },
];

describe("SearchableSessionPicker", () => {
  it("renders all sessions and marks the current session", () => {
    const picker = new SearchableSessionPicker({
      sessions: sampleSessions,
      currentSessionId: "session-22222222",
      onSelect: () => {},
      onCancel: () => {},
    });

    const lines = picker.render(80).join("\n");
    expect(lines).toContain("Switch Session");
    expect(lines).toContain("Docker container inspection");
    expect(lines).toContain("Muse spark benchmark");
    expect(lines).toContain("Branch test run");
    expect(lines).toContain("↳ branch");
    expect(lines).toContain("✓");
  });

  it("filters sessions in real time via typing", () => {
    const picker = new SearchableSessionPicker({
      sessions: sampleSessions,
      onSelect: () => {},
      onCancel: () => {},
    });

    picker.handleInput("m");
    picker.handleInput("u");
    picker.handleInput("s");
    picker.handleInput("e");

    const lines = picker.render(80).join("\n");
    expect(lines).toContain("Muse spark benchmark");
    expect(lines).not.toContain("Docker container inspection");
  });

  it("selects session on Enter", () => {
    let selectedSession: ProductSessionRow | null = null;
    const picker = new SearchableSessionPicker({
      sessions: sampleSessions,
      onSelect: (s: ProductSessionRow) => {
        selectedSession = s;
      },
      onCancel: () => {},
    });

    picker.handleInput("\r");
    expect(selectedSession).not.toBeNull();
    expect((selectedSession as ProductSessionRow | null)?.thebeSessionId).toBe("session-11111111");
  });

  it("navigates with Up and Down arrows", () => {
    let selectedSession: ProductSessionRow | null = null;
    const picker = new SearchableSessionPicker({
      sessions: sampleSessions,
      onSelect: (s: ProductSessionRow) => {
        selectedSession = s;
      },
      onCancel: () => {},
    });

    picker.handleInput("\x1b[B"); // Down arrow
    picker.handleInput("\r"); // Enter
    expect((selectedSession as ProductSessionRow | null)?.thebeSessionId).toBe("session-22222222");
  });

  it("cancels on Escape", () => {
    let cancelled = false;
    const picker = new SearchableSessionPicker({
      sessions: sampleSessions,
      onSelect: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });

    picker.handleInput("\x1b"); // Esc
    expect(cancelled).toBe(true);
  });
});
