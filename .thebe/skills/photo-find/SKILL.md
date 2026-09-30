---
name: photo-find
description: Find photos or videos in Immich by what is visible in them. Use when the user describes a scene, object, or moment rather than a filename, date, or city.
---

# Photo find

Use Core's photo search tool.

## Semantic search

- Call `immich.search` with the description as `query`. This matches image content through the server's machine-learning index.
- Filename, date, and city filters are a different search. Use this skill when the user describes what is in the picture.
- Page with `page` and `size` (1-40). Keep each returned asset id and filename so a later reference stays exact.
- Do not invent assets, places, or dates that the tool did not return.

If the tool fails, report that failure. An unavailable machine-learning search is not an empty library. If `immich.search` is not available, Immich is not configured.
