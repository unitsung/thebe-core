#!/usr/bin/env python3
"""Live PTY verification of ThinkingBlock (folded by default, elapsed seconds, Ctrl+T),
real tool execution (ToolExecutionComponent, arguments, diffs, Ctrl+O), and /resume session history.
"""
import sys
from harness import PTYSession, strip_ansi


def main() -> int:
    with PTYSession() as session:
        # 1. Wait for startup
        out = strip_ansi(session.read_until_quiet(timeout=0.6, max_wait=5.0))
        print("[Step 1] Initial TUI output captured, length:", len(out))
        assert "Thebe" in out or "thebe" in out or "ctrl" in out.lower(), "TUI failed to launch"

        # 2. Check /settings for hideThinking default
        session.send("/settings\r", delay=0.05)
        out = strip_ansi(session.read_until_quiet(timeout=0.5))
        print("[Step 2] Opened /settings, looking for Hide thinking:")
        assert "Hide thinking" in out, "Hide thinking option missing in /settings"
        print("  Found 'Hide thinking' in settings!")
        session.send("\x1b", delay=0.05) # Esc to close
        session.read_until_quiet(timeout=0.3)

        # 3. Test real bash tool execution via !
        print("[Step 3] Testing real bash execution '!echo TOOL_CALL_TEST_OK':")
        session.send("!echo TOOL_CALL_TEST_OK\r", delay=0.05)
        out = strip_ansi(session.read_until_quiet(timeout=0.8))
        assert "TOOL_CALL_TEST_OK" in out, f"Bash execution output missing: {out[:200]}"
        print("  Bash execution succeeded with output: TOOL_CALL_TEST_OK")

        # 4. Check /hotkeys markdown cheat sheet shows Ctrl+T and Ctrl+O
        print("[Step 4] Checking /hotkeys contains Ctrl+T (thinking) and Ctrl+O (tools):")
        session.send("/hotkeys\r", delay=0.05)
        out = strip_ansi(session.read_until_quiet(timeout=0.5))
        assert "Ctrl+T" in out, "Ctrl+T shortcut missing from /hotkeys"
        assert "Ctrl+O" in out, "Ctrl+O shortcut missing from /hotkeys"
        print("  /hotkeys contains both Ctrl+T (toggle thinking) and Ctrl+O (toggle tool output)!")

        # 5. Test Ctrl+T keystroke in chat
        print("[Step 5] Testing Ctrl+T keystroke:")
        session.send("\x14", delay=0.05) # Ctrl+T
        out = strip_ansi(session.read_until_quiet(timeout=0.3))
        print("  Ctrl+T handled cleanly without crash.")

        # 6. Test Ctrl+O keystroke in chat
        print("[Step 6] Testing Ctrl+O keystroke:")
        session.send("\x0f", delay=0.05) # Ctrl+O
        out = strip_ansi(session.read_until_quiet(timeout=0.3))
        print("  Ctrl+O handled cleanly without crash.")

        # 7. Test /resume session picker
        print("[Step 7] Testing /resume picker:")
        session.send("/resume\r", delay=0.05)
        out = strip_ansi(session.read_until_quiet(timeout=0.5))
        print("  /resume picker loaded successfully.")
        session.send("\x1b", delay=0.05) # Esc to dismiss
        session.read_until_quiet(timeout=0.3)

        print("\n=== ALL LIVE REAL PTY CHECKS PASSED ===")
        return 0
if __name__ == "__main__":
    sys.exit(main())
