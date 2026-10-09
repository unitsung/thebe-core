---
name: download-monitor
description: Check the state of downloads and acquisition jobs, find stalled or failed ones, and explain what to do next. Use when the user asks how a download is going, why something has not appeared in the library, or to resume a failed job.
---

# Download monitor

Use Core's download and pipeline tools. They exist only when the downloader and file manager are configured.

## Check progress

- `download.list` shows tasks. Filter with `filter` (`downloading`, `completed`, `paused`, `errored`) and `category`; keep `limit` small. Keep each torrent info-hash so a later reference such as "the second one" stays exact.
- `download.status` takes that `hash` and returns progress, state, save path and content path. Submission is not completion: a task only counts as finished when it reports completed.
- `pipeline.status` lists acquisition jobs, their stage, attempt counts, log and any failure advice. Pass `jobId` for one job.

## Find what is stuck

- To hold or restart a download the user names, call `download.pause` or `download.resume` with its info-hash in `hashes` (from `download.list`). They need approval, never delete the task or its files, and are only available when the downloader supports them. Confirm the new state with `download.status`; a resumed finished download shows as seeding. Do not pause or resume downloads the user did not ask about.
- `download.delete` is irreversible and needs approval. Use it only when the user explicitly asks to remove a download, and always state `deleteFiles`: `false` keeps the downloaded files, `true` deletes them too. If the user did not say, ask rather than choose. Prefer `download.pause` when they only want it to stop.
- A job that is not done and not failed can move forward: call `pipeline.advance` with its `jobId`. It performs whatever step is possible now and never blocks, so call it again later rather than in a tight loop.
- A failed job carries a reason and advice. Report both to the user and fix the stated cause before advancing again; advancing without a fix repeats the failure.
- If a completed download is not in the library, inspect the folder with `files.list` (absolute `path`) and then check the media server with `emby.search` or `jellyfin.search` before saying where the break is. `library.scan` is the approval-gated way to ask the server to rescan; scanning is asynchronous, so verify with a search afterwards.

## Report

State what the tools returned: task name, state, progress, and the stage a job is in. Do not infer completion, speed, or a cause the tools did not show. If a tool is unavailable, that downloader or file manager is not configured.
