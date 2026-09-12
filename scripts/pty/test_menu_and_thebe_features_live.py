#!/usr/bin/env python3
"""Focused PTY check for slash commands, thinking footer placement, and Thebe menus."""
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ansi_escape = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def strip_ansi(text: str) -> str:
    return ansi_escape.sub("", text)


def set_pty_size(fd: int, rows: int, cols: int) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    import fcntl

    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main() -> int:
    master, slave = pty.openpty()
    set_pty_size(master, 32, 120)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.chdir(ROOT)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ["FORCE_COLOR"] = "1"
        os.execvp("node", ["node", "dist/tui.js"])
        os._exit(1)

    os.close(slave)

    def read_until_quiet(timeout: float = 0.4, max_wait: float = 4.0) -> str:
        start = time.time()
        buf = b""
        last = time.time()
        while time.time() - start < max_wait:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 8192)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                last = time.time()
            elif buf and time.time() - last >= timeout:
                break
        return buf.decode("utf-8", errors="replace")

    def send(keys, delay=0.08):
        os.write(master, keys if isinstance(keys, bytes) else keys.encode())
        time.sleep(delay)

    def clear_editor():
        send("\x1b")
        send("\x15")
        send("\x7f" * 48, delay=0.02)
        read_until_quiet(timeout=0.2, max_wait=1.0)

    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        if ok:
            print(f"✓ {name}")
        else:
            failures.append(name)
            print(f"✗ {name} {detail}".rstrip())

    try:
        boot = strip_ansi(read_until_quiet(timeout=0.8, max_wait=6.0))
        check("TUI started", "Thebe" in boot or "Enter to send" in boot or "0.0%/" in boot or "thinking" in boot, boot[-400:])

        send("/")
        send("ski")
        slash_skills = strip_ansi(read_until_quiet())
        check("slash menu has skills", "skills" in slash_skills.lower(), slash_skills[-300:])
        clear_editor()

        send("/mcp")
        slash_mcp = strip_ansi(read_until_quiet())
        check("slash menu has mcp", "mcp" in slash_mcp.lower(), slash_mcp[-300:])
        clear_editor()

        send("/suba")
        slash_sub = strip_ansi(read_until_quiet())
        check("slash menu has subagent", "subagent" in slash_sub.lower(), slash_sub[-300:])
        clear_editor()

        send("\x1b[Z")  # Shift+Tab: off -> minimal
        after_tab = strip_ansi(read_until_quiet())
        check(
            "Shift+Tab is silent",
            "thinking level set to" not in after_tab.lower(),
            after_tab[-300:],
        )
        check(
            "footer shows model • effective level on one line",
            re.search(
                r"•\s*(off|minimal|low|medium|high|xhigh|max)",
                after_tab.lower(),
            )
            is not None
            and "thinking minimal" not in after_tab.lower(),
            after_tab[-300:],
        )
        lines = [line for line in after_tab.splitlines() if line.strip()]
        last = "\n".join(lines[-6:]).lower()
        check(
            "effective level sits with the model name",
            re.search(
                r"•\s*(off|minimal|low|medium|high|xhigh|max)",
                last,
            )
            is not None,
            last,
        )

        clear_editor()
        send("/help\r")
        help_out = strip_ansi(read_until_quiet(timeout=0.6, max_wait=5.0))
        check(
            "help lists Thebe commands",
            "skills" in help_out.lower() and "mcp" in help_out.lower(),
            "len=%s tail=%s" % (len(help_out), help_out[-500:]),
        )

        clear_editor()
        send("/skills list\r")
        skills_out = strip_ansi(read_until_quiet(timeout=0.6, max_wait=5.0))
        check(
            "/skills runs",
            "skill" in skills_out.lower() or "no skills" in skills_out.lower(),
            "len=%s tail=%s" % (len(skills_out), skills_out[-400:]),
        )

        clear_editor()
        send("/mcp list\r")
        mcp_out = strip_ansi(read_until_quiet(timeout=0.6, max_wait=5.0))
        check(
            "/mcp lists core tools",
            "container.list" in mcp_out or "list_core_events" in mcp_out,
            mcp_out[-300:],
        )

        clear_editor()
        send("/subagent list\r")
        sub_out = strip_ansi(read_until_quiet(timeout=0.6, max_wait=5.0))
        check(
            "/subagent list runs",
            "subagent" in sub_out.lower() or "no active" in sub_out.lower(),
            sub_out[-300:],
        )

        send("/quit\r")
        read_until_quiet(timeout=0.3, max_wait=2.0)
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        os.close(master)

    if failures:
        print("FAILED:", ", ".join(failures))
        return 1
    print("ALL LIVE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
