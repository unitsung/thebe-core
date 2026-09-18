# Judgment Model is an opt-in typed layer, not a chat provider

Many Core places currently jump from deterministic rules to a chat model that emits JSON. A hosted typed model (Jev) can answer bounded questions with calibrated probabilities, but homelab state leaving the box is a trust cost, and PolicyEngine already owns `decide`. Core therefore adds a Judgment Model Interface behind a Judgment Gate that defaults off. Callers opt in per Site via `judgment.ask`. Off, missing credentials, a Site that is not enabled, or a failed call keep that Site's traditional path. On, deterministic observation still runs first; the model answers typed questions only; the chat model may still write narrative; neither model may approve, execute, or verify.

Rejected: naming the layer Jev; putting it on 服务商; replacing PolicyEngine; making diagnosis the owner of the layer; dual-running every call; App Settings in this slice.

The catalog is inventory. Diagnosis is one optional caller. `THEBE_JUDGMENT_SITES` can enable a subset (or all, or none) without forcing every place. High-confidence deterministic restart recommendations are not vetoed by a low Noul.
