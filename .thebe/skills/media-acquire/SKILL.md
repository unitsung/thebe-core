---
name: media-acquire
description: Find a release of a movie, series, or album the user wants and, once they choose one, download it into the media library. Use when the user asks to get, download, or add a title that is not yet in the library.
---

# Media acquire

Use Core's `resource.search` and `pipeline.*` tools. They exist only when an indexer, downloader, file manager and media server are configured.

## Check first

Look for the title with `emby.search` or `jellyfin.search` before searching for releases. If it is already in the library, say so and stop.

## Search and let the user choose

- Call `resource.search` with the title and year in `query`, and `type` (`movie`, `tv`, `music`, or `any`). Search never downloads.
- Show the best few releases with title, size, seeders and quality exactly as returned. Ask which one to use. Do not pick a release for the user, and do not invent sizes, seeders or quality.

## Acquire

- Only after the user picks a release, call `pipeline.acquire` with `title`, `year`, the chosen release's `magnet`, `filesSourceDir` and `libraryDir`. Take the directories from the user or from configuration the tools show; do not guess paths. Pass `mediaServer` when more than one is configured.
- Acquisition needs approval once for the whole plan. Wait for it; do not retry or work around a denial.
- The job advances through download, copy, library scan and verification. Use `pipeline.status` to follow it and `pipeline.advance` to move it, as in the `download-monitor` skill. Call a job done only when its stage is done.

## Report

Say what was started and the job id, then what the job's stage actually is. If the release has no usable magnet, the search returned nothing, or a tool is unavailable, report that plainly instead of substituting a different release.
