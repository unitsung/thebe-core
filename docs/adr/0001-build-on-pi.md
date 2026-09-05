# Build on Pi as a library

Thebe Core is an agent, but we will not write the agent loop, session machinery, or model streaming ourselves. We depend on `@earendil-works/pi-agent-core` as a library. This repo owns the process, the `ask` entry, and Homelab tools.

The official `pi` CLI is a coding TUI with bash/edit/write. Forking Pi would inherit their release cadence. Neither fits a Homelab agent whose v0.3 surface is four read-only container tools.
