---
name: navidrome-recommend
description: Recommend music from the user's Navidrome library, curate mood-based playlists, or refine earlier recommendations for playback or playlist creation.
---

# Navidrome recommendations

Use Core's `navidrome.*` tools. The App owns playback; `navidrome.queue` supplies playable items.

## Match the request

- Daily recommendations default to 30 tracks when the user supplies no count. This default applies only to daily recommendations.
- Mood recommendations and playlist creation follow the requested count, listening duration, or other constraints. Without a quantity, choose a useful size for the stated use or clarify when size materially affects the result; there is no universal 30-track cap.
- Refining or extending an existing selection reuses verified IDs and changes only the requested portion. Preserve the original order unless the user asks to reorder.
- A combined request to create a playlist and play it is one workflow: select, request the existing write approval, create, then queue the verified playlist or selected songs. Keep the playback request through the approval pause; do not ask for it again after successful creation.

## Select music

- Apply the user's stated preferences, exclusions, mood, and requested track count. Treat loaded album summaries as a partial library view.
- For personalization, read a small sample of `navidrome.library` with `recently_played`, `frequent`, or `starred`. Use `random` or `recommended` for discovery. Recently added albums alone are not listening preferences.
- Set each read's `limit` to the candidates needed for the request. For exploration, start with a small sample and expand only when it lacks suitable candidates. Search specific artists or titles to resolve playable songs. Page library results with `offset` when the requested selection exceeds one response; a per-call limit is not a limit on playlist length.
- Use `navidrome.artist` for similarity when useful. Verify suggested artists and tracks in the library; separate outside-library suggestions from available music. If listening history is empty, use the supplied mood or ask one useful preference question.
- Explain selection using observed library facts and clearly identified musical judgment. Library membership alone does not establish that the user likes a track.

## Return reusable recommendations

Present a concise ordered selection with title, artist, short reason, and exact song ID from tools. Include those identities in ordinary Markdown so later references such as “play the second one” remain resolvable. Keep the user's requested count; do not fill gaps with invented songs or IDs.

For a playback request, pass the selected IDs in the same order to `navidrome.queue`. Follow the host tool schema for parameter names and supported target types. Use returned stream URLs for audio cards. For album playback, use a verified album ID when the host supports it; otherwise resolve that album's verified song IDs first. Resolve ambiguous earlier references before queuing.

Create or update a playlist only when requested and through the runtime approval flow. Honor playback requested in the same instruction. A recommendation alone does not authorize playback or playlist changes. Describe completion only after a successful tool result; if creation fails, report that failure rather than claiming the playlist exists.

## Context economy

Reuse earlier verified candidates and preferences before repeating searches. Batch playlist creation with ordered song IDs, and batch appends, using the host's parameter schema rather than writing one song at a time. Read lyrics only when the request needs lyrical analysis and the host provides that capability. Fetch playback URLs only when needed for requested playback, disabling optional lyrics unless needed. Keep selection, IDs, order, and exclusions explicit in the conversation so runtime compaction can retain them.

When a tool returns no matches, broaden the query or change the library mode instead of repeating the identical call. Stop expanding once the selection meets the request. If the library or remaining tool budget cannot supply enough verified tracks, report the actual shortfall and offer the available selection; keep the user's target count distinct from the smaller result.
