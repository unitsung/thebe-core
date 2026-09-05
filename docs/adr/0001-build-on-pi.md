# Build on Pi instead of writing an agent loop

Thebe Core is an agent, but we will not write the agent loop, session machinery, or model streaming ourselves. Those belong to Earendil's Pi harness (`@earendil-works/pi-agent-core` and related packages). This repo owns Homelab-specific capability: read-only container tools, the Arcane adapter, policy, and redaction.

Hand-rolling the loop already failed. Wrapping a different agent framework would spend the same energy on someone else's abstractions. Pi is the loop; Thebe Core is the Homelab tools and constraints on top of it.
