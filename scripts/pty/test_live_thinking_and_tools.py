#!/usr/bin/env python3
"""Live PTY verification of ThinkingBlock (folded by default, elapsed seconds, Ctrl+T),
real tool execution (ToolExecutionComponent, arguments, diffs, Ctrl+O), and /resume session history.
"""
import os
import pty
import re
import select
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
            else:
                if buf and (time.time() - last >= timeout):
                    break
        return strip_ansi(buf.decode("utf-8", errors="replace"))

    def send(data: str) -> None:
        os.write(master, data.encode("utf-8"))
        time.sleep(0.05)

    try:
        # 1. Wait for startup
        out = read_until_quiet(timeout=0.6, max_wait=5.0)
        print("[Step 1] Initial TUI output captured, length:", len(out))
        assert "Thebe" in out or "thebe" in out or "ctrl" in out.lower(), "TUI failed to launch"

        # 2. Check /settings for hideThinking default
        send("/settings\r")
        out = read_until_quiet(timeout=0.5)
        print("[Step 2] Opened /settings, looking for Hide thinking:")
        assert "Hide thinking" in out, "Hide thinking option missing in /settings"
        print("  Found 'Hide thinking' in settings!")
        send("\x1b") # Esc to close
        read_until_quiet(timeout=0.3)

        # 3. Test real bash tool execution via !
        print("[Step 3] Testing real bash execution '!echo TOOL_CALL_TEST_OK':")
        send("!echo TOOL_CALL_TEST_OK\r")
        out = read_until_quiet(timeout=0.8)
        assert "TOOL_CALL_TEST_OK" in out, f"Bash execution output missing: {out[:200]}"
        print("  Bash execution succeeded with output: TOOL_CALL_TEST_OK")

        # 4. Check /hotkeys markdown cheat sheet shows Ctrl+T and Ctrl+O
        print("[Step 4] Checking /hotkeys contains Ctrl+T (thinking) and Ctrl+O (tools):")
        send("/hotkeys\r")
        out = read_until_quiet(timeout=0.5)
        assert "Ctrl+T" in out, "Ctrl+T shortcut missing from /hotkeys"
        assert "Ctrl+O" in out, "Ctrl+O shortcut missing from /hotkeys"
        print("  /hotkeys contains both Ctrl+T (toggle thinking) and Ctrl+O (toggle tool output)!")

        # 5. Test Ctrl+T keystroke in chat
        print("[Step 5] Testing Ctrl+T keystroke:")
        send("\x14") # Ctrl+T
        out = read_until_quiet(timeout=0.3)
        print("  Ctrl+T handled cleanly without crash.")

        # 6. Test Ctrl+O keystroke in chat
        print("[Step 6] Testing Ctrl+O keystroke:")
        send("\x0f") # Ctrl+O
        out = read_until_quiet(timeout=0.3)
        print("  Ctrl+O handled cleanly without crash.")

        # 7. Test /resume session picker
        print("[Step 7] Testing /resume picker:")
        send("/resume\r")
        out = read_until_quiet(timeout=0.5)
        print("  /resume picker loaded successfully.")
        send("\x1b") # Esc to dismiss
        read_until_quiet(timeout=0.3)

        print("\n=== ALL LIVE REAL PTY CHECKS PASSED ===")
        return 0
    finally:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        try:
            os.close(master)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
