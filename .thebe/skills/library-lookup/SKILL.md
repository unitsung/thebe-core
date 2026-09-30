---
name: library-lookup
description: Find a movie or series in the Emby or Jellyfin library and read its overview, year, genres, and cast. Use when the user asks whether a title is in the library, what it is about, or who is in it.
---

# Library lookup

Use Core's library lookup tools.

## Find the title

- Search with `emby.search` or `jellyfin.search`, using the server that is configured. Pass the title as `query`. Pass a cast or crew name as `person`. Pass a known release year as `year`.
- Page with `startIndex` and `limit` (1-40). The default types are Movie and Series.
- Keep the item id, title, type, and year from the result. A later request such as "the second one" must still resolve to that id.

## Read the record

- Call `emby.item` or `jellyfin.item` with that verified id before describing the overview, genres, or cast.
- People are the library record: name, role, and type. Do not invent a biography.
- `communityRating` is the media server's own rating. Label it as such. Do not present it as a Douban score, and do not invent a rating the tool did not return.
- A missing item comes back empty. Say that it was not found. Search by title and year before treating a title alone as a library id.

When the search fails, report the failure. Do not claim the library contains a title the tool did not return. If the lookup tools are not available, that server is not configured.
