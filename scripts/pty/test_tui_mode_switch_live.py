#!/usr/bin/env python3
"""PTY check: /tui fullscreen <-> regular must keep accepting keys."""

import sys

from harness import PTYSession, strip_ansi


def main() -> int:
    failures = []

    def check(name, ok, detail=""):
        if ok:
            print("OK", name)
        else:
            failures.append(name)
            print("FAIL", name, detail[-500:] if detail else "")

    with PTYSession(isolated=True) as session:
        boot = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("boot", "Thebe" in boot or "Enter to send" in boot, boot)
        session.clear_editor()
        session.send("/tui fullscreen\r")
        after_full = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("switch to fullscreen returned", "switching" in after_full.lower() or "fullscreen" in after_full.lower() or "Thebe" in after_full or "0.0%/" in after_full, after_full)
        session.clear_editor()
        session.send("/help\r")
        help_full = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("keys work after fullscreen", "skills" in help_full.lower() or "Thebe Commands" in help_full or "/help" in help_full.lower(), f"len={len(help_full)} tail={help_full[-400:]}")
        session.clear_editor()
        session.send("/tui regular\r")
        after_reg = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("switch to regular returned", "switching" in after_reg.lower() or "regular" in after_reg.lower() or "Thebe" in after_reg, after_reg)
        session.clear_editor()
        session.send("/help\r")
        help_reg = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("keys work after regular", "skills" in help_reg.lower() or "Thebe Commands" in help_reg or "/help" in help_reg.lower(), f"len={len(help_reg)} tail={help_reg[-400:]}")
        session.send("/quit\r")
        session.read_until_quiet(timeout=0.3, max_wait=2.0)

    if failures:
        print("FAILED:", ", ".join(failures))
        return 1
    print("ALL MODE SWITCH CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
