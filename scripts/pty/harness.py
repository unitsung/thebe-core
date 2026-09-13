"""Small shared harness for the manually-run live PTY scenarios."""

import os
import pty
import re
import select
import signal
import shutil
import struct
import tempfile
import termios
import time


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ANSI_ESCAPE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE.sub("", text)


class PTYSession:
    """Run dist/tui.js in a sized PTY and provide the common I/O operations."""

    def __init__(self, *, isolated: bool = False, rows: int = 32, cols: int = 120) -> None:
        self.rows = rows
        self.cols = cols
        self.isolated = isolated
        self.master: int | None = None
        self.pid: int | None = None
        self._temp_dir: str | None = None

    def __enter__(self) -> "PTYSession":
        self.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()

    def start(self) -> None:
        if self.master is not None:
            raise RuntimeError("PTY session already started")

        master, slave = pty.openpty()
        self.master = master
        self._set_size(master)
        if self.isolated:
            self._temp_dir = tempfile.mkdtemp(prefix="thebe-tui-")
        self.pid = os.fork()
        if self.pid == 0:
            os.close(master)
            os.setsid()
            os.dup2(slave, 0)
            os.dup2(slave, 1)
            os.dup2(slave, 2)
            if slave > 2:
                os.close(slave)
            os.chdir(ROOT)
            os.environ.update(
                TERM="xterm-256color",
                COLORTERM="truecolor",
                FORCE_COLOR="1",
            )
            if self.isolated:
                os.environ.update(
                    THEBE_CONFIG_DIR=self._temp_dir,
                    THEBE_SESSION_DIR=os.path.join(self._temp_dir, "sessions"),
                    THEBE_AGENT_STORE_DIR=os.path.join(self._temp_dir, "store"),
                    THEBE_AGENT_DIR=os.path.join(self._temp_dir, "agent"),
                )
            os.execvp("node", ["node", "dist/tui.js"])
            os._exit(1)

        os.close(slave)

    def _set_size(self, fd: int) -> None:
        import fcntl

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))

    def read_until_quiet(self, timeout: float = 0.4, max_wait: float = 4.0) -> str:
        if self.master is None:
            raise RuntimeError("PTY session is not started")
        start = time.time()
        buf = b""
        last = start
        while time.time() - start < max_wait:
            ready, _, _ = select.select([self.master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(self.master, 8192)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                last = time.time()
            elif buf and time.time() - last >= timeout:
                break
        return buf.decode("utf-8", errors="replace")

    def send(self, keys: str | bytes, delay: float = 0.08) -> None:
        if self.master is None:
            raise RuntimeError("PTY session is not started")
        os.write(self.master, keys if isinstance(keys, bytes) else keys.encode())
        time.sleep(delay)

    def clear_editor(self, delete_count: int = 40) -> None:
        self.send("\x1b")
        self.send("\x15")
        self.send("\x7f" * delete_count, delay=0.01)
        self.read_until_quiet(timeout=0.15, max_wait=0.8)

    def close(self) -> None:
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
            self.pid = None
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
            self.master = None
        if self._temp_dir is not None:
            shutil.rmtree(self._temp_dir, ignore_errors=True)
            self._temp_dir = None
