#!/usr/bin/env python3
"""Focused PTY check for slash commands, thinking footer placement, and Thebe menus."""

import re
import sys

from harness import PTYSession, strip_ansi


def main() -> int:
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        if ok:
            print(f"✓ {name}")
        else:
            failures.append(name)
            print(f"✗ {name} {detail}".rstrip())

    with PTYSession(isolated=True) as session:
        boot = strip_ansi(session.read_until_quiet(timeout=0.8, max_wait=6.0))
        check("TUI started", "Thebe" in boot or "Enter to send" in boot or "0.0%/" in boot or "thinking" in boot, boot[-400:])

        session.send("/")
        session.send("ski")
        slash_skills = strip_ansi(session.read_until_quiet())
        check("slash menu has skills", "skills" in slash_skills.lower(), slash_skills[-300:])
        session.clear_editor(48)
        session.send("/mcp")
        slash_mcp = strip_ansi(session.read_until_quiet())
        check("slash menu has mcp", "mcp" in slash_mcp.lower(), slash_mcp[-300:])
        session.clear_editor(48)
        session.send("/suba")
        slash_sub = strip_ansi(session.read_until_quiet())
        check("slash menu has subagent", "subagent" in slash_sub.lower(), slash_sub[-300:])

        session.send("\x1b[Z")
        after_tab = strip_ansi(session.read_until_quiet())
        check("Shift+Tab is silent", "thinking level set to" not in after_tab.lower(), after_tab[-300:])
        check("footer shows model • effective level on one line", re.search(r"•\s*(off|minimal|low|medium|high|xhigh|max)", after_tab.lower()) is not None and "thinking minimal" not in after_tab.lower(), after_tab[-300:])
        lines = [line for line in after_tab.splitlines() if line.strip()]
        last = "\n".join(lines[-6:]).lower()
        check("effective level sits with the model name", re.search(r"•\s*(off|minimal|low|medium|high|xhigh|max)", last) is not None, last)

        session.clear_editor()
        session.send("/help\r")
        help_out = strip_ansi(session.read_until_quiet(timeout=0.6, max_wait=5.0))
        check("help lists Thebe commands", "skills" in help_out.lower() and "mcp" in help_out.lower(), f"len={len(help_out)} tail={help_out[-500:]}")
        session.clear_editor()
        session.send("/skills list\r")
        skills_out = strip_ansi(session.read_until_quiet(timeout=0.6, max_wait=5.0))
        check("/skills runs", "skill" in skills_out.lower() or "no skills" in skills_out.lower(), f"len={len(skills_out)} tail={skills_out[-400:]}")
        session.clear_editor()
        session.send("/mcp list\r")
        mcp_out = strip_ansi(session.read_until_quiet(timeout=0.6, max_wait=5.0))
        check("/mcp lists core tools", "container.list" in mcp_out or "list_core_events" in mcp_out, mcp_out[-300:])
        session.clear_editor()
        session.send("/subagent list\r")
        sub_out = strip_ansi(session.read_until_quiet(timeout=0.6, max_wait=5.0))
        check("/subagent list runs", "subagent" in sub_out.lower() or "no active" in sub_out.lower(), sub_out[-300:])
        session.send("/quit\r")
        session.read_until_quiet(timeout=0.3, max_wait=2.0)

    if failures:
        print("FAILED:", ", ".join(failures))
        return 1
    print("ALL LIVE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
