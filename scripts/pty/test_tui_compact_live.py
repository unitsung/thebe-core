#!/usr/bin/env python3
"""PTY check: official /compact on an empty session, /session auto-compact status."""
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ansi_escape = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def strip_ansi(text):
    return ansi_escape.sub("", text)


def set_pty_size(fd, rows, cols):
    import fcntl

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    tmp = tempfile.mkdtemp(prefix="thebe-tui-compact-")
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
        os.environ["THEBE_CONFIG_DIR"] = tmp
        os.environ["THEBE_SESSION_DIR"] = os.path.join(tmp, "sessions")
        os.environ["THEBE_PRODUCT_STORE_DIR"] = os.path.join(tmp, "store")
        os.environ["THEBE_AGENT_DIR"] = os.path.join(tmp, "agent")
        os.execvp("node", ["node", "dist/tui.js"])
        os._exit(1)

    os.close(slave)

    def read_until_quiet(timeout=0.4, max_wait=6.0):
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
        send("\x7f" * 40, delay=0.01)
        read_until_quiet(timeout=0.15, max_wait=0.8)

    failures = []

    def check(name, ok, detail=""):
        if ok:
            print("OK", name)
        else:
            failures.append(name)
            print("FAIL", name, detail[-600:] if detail else "")

    try:
        boot = strip_ansi(read_until_quiet(timeout=0.8, max_wait=6.0))
        check("boot", "Thebe" in boot or "Enter to send" in boot, boot)

        clear_editor()
        send("/help\r")
        help_text = strip_ansi(read_until_quiet(timeout=0.8, max_wait=6.0))
        check(
            "help lists /compact [prompt]",
            "/compact" in help_text.lower() and "[prompt]" in help_text.lower(),
            help_text,
        )

        clear_editor()
        send("/compact\r")
        compact_text = strip_ansi(read_until_quiet(timeout=0.8, max_wait=8.0))
        lower = compact_text.lower()
        check(
            "empty compact is not fake success",
            "nothing to compact" in lower or "already compacted" in lower,
            compact_text,
        )
        check(
            "empty compact does not claim success",
            "compacted successfully" not in lower,
            compact_text,
        )

        clear_editor()
        send("/session\r")
        session_text = strip_ansi(read_until_quiet(timeout=0.8, max_wait=6.0))
        check(
            "session shows auto-compaction on",
            "auto-compaction" in session_text.lower() and "on" in session_text.lower(),
            session_text,
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
    print("ALL COMPACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
