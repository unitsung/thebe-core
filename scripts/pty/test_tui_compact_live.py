#!/usr/bin/env python3
"""PTY check: official /compact on an empty session, /session auto-compact status."""

import sys

from harness import PTYSession, strip_ansi


def main() -> int:
    failures = []

    def check(name, ok, detail=""):
        if ok:
            print("OK", name)
        else:
            failures.append(name)
            print("FAIL", name, detail[-600:] if detail else "")

    with PTYSession(isolated=True) as session:
        boot = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("boot", "Thebe" in boot or "Enter to send" in boot, boot)
        session.clear_editor()
        session.send("/help\r")
        help_text = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("help lists /compact [prompt]", "/compact" in help_text.lower() and "[prompt]" in help_text.lower(), help_text)
        session.clear_editor()
        session.send("/compact\r")
        compact_text = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=8.0))
        lower = compact_text.lower()
        check("empty compact is not fake success", "nothing to compact" in lower or "already compacted" in lower, compact_text)
        check("empty compact does not claim success", "compacted successfully" not in lower, compact_text)
        session.clear_editor()
        session.send("/session\r")
        session_text = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("session shows auto-compaction on", "auto-compaction" in session_text.lower() and "on" in session_text.lower(), session_text)
        session.send("/quit\r")
        session.read_until_quiet(timeout=0.3, max_wait=2.0)

    if failures:
        print("FAILED:", ", ".join(failures))
        return 1
    print("ALL COMPACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
