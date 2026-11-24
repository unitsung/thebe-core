# IM owner access is a direct chat plus a pinned sender

Thebe is a single-owner product, but a discoverable bot can receive messages from anyone. A binding to the Main Session is therefore a security boundary, not just routing: only a direct chat bound as `owner` through the authenticated Core API may prompt the model, and the binding records the platform sender id seen for that chat. A later message in the same chat from a different sender is dropped. Group chats are recorded as conversations but cannot be bound as owner; a group `guest` binding is record-only and never reaches the model.

This rejects chat-only binding (any participant could command Thebe), a separate sender allowlist (more configuration than the single-owner product needs), and a pairing code (not needed while binding is local and authenticated) for Phase 1. The cost is that changing the owner's platform account requires re-binding the chat.

**Consequences:** binding requires an observed conversation and pins its last observed sender (an explicit sender id must match that observation); legacy owner bindings without a sender id do not prompt until re-bound; a shared chat never broadens model access.
