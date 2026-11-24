# Two-way IM keeps its own adapter seam

`ChannelAdapter` is a write-only notification transport for Ticket notices; two-way IM needs inbound messages, account lifecycle, login/QR, reply windows, and platform-specific credentials. We keep `ImAdapter`/`ImGateway` as a separate seam, with platform quirks (transport, auth, chunking, reply windows) inside adapters and common policy (registry, owner binding, durable dedupe, per-chat queue, send gating) in the gateway. Before adding QQ, WeChat, or iMessage we freeze that seam around a platform registry, per-platform credential schema with validation, optional login adapters, a truthful capability descriptor, optional thread/media inbound fields, and a cursor identity that changes with the bot/account identity.

We deliberately do not embed external agent gateways or Python sidecars: they are reference implementations for contracts and edge cases, not runtime dependencies. Extending `ChannelAdapter` into a bidirectional interface was rejected because it would force every notification target to carry a receive/lifecycle model it does not need.

**Consequences:** each platform adapter owns more code, but the gateway never learns platform-specific fields; an `ImNotificationAdapter` can later map IM capabilities into the existing notification router; host-supplied adapters register through the same factory boundary.
