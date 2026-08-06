# Changelog

All notable changes to cse-bridge. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [1.1.0] - 2026-08-06

### Added

- **`searchType=image`.** Image clients now migrate with the same one-line base-URL change web clients already get. The bridge switches the backend query to SearXNG's `images` category and maps its image results into Google's exact item shape: `link` is the image file itself (`img_src`), `image.contextLink` is the page it was found on, `image.thumbnailLink` comes from `thumbnail_src`, `image.width`/`image.height` are parsed from the human-readable `resolution` ("1920 x 1080"), `image.byteSize` from `filesize` ("412 KB", 1 KB = 1024), and `mime`/`fileFormat` from `img_format` (`jpg` → `image/jpeg`). Any of these an engine does not report is **omitted, never guessed** — including `image.thumbnailWidth`/`thumbnailHeight`, which SearXNG never reports. A result with no image URL is dropped entirely rather than emitted with a page URL as `link`. `searchType` round-trips through `queries.request[0]`, as on Google, and `image` is the only accepted value — anything else gets Google's `INVALID_ARGUMENT` envelope.
- **`imgSize`, `imgType`, `imgColorType`, `imgDominantColor`** are validated against Google's exact enums (out-of-enum values get Google's 400, because Google rejects them too) and then accepted for compatibility. SearXNG has no size/type/color parameters to map them onto, so they do not filter — the same documented posture as `sort` expressions beyond `date`.
- `searchType=image` **supersedes the profile's `categories`** rather than merging with them: a `cx` pinned to `categories: [news]` cannot also be an image engine. The profile's `site:` restriction, language and engines still apply.

### Fixed

- **Gallery de-dupe.** Result de-duplication keyed on the result's `url` — but for image results `url` is the *page* the image sits on, so ten images from one gallery collapsed into one item. De-duplication now keys on `img_src` when present, falling back to `url` for web results.

### Notes

- Image and web result sets for the same query occupy separate cache entries (the cache key already included `categories`), so alternating between `searchType=image` and web search never leaks results across.

## [1.0.2] - 2026-08-03

- Docs only. The npm README now shows the reader-facing "Further reading and feedback" section instead of the maintainer-facing distribution notes; `package-lock.json` re-synced with the package version.

## [1.0.1] - 2026-08-03

- `docker-compose.yml` referenced `ghcr.io/Booyaka101/...` (mixed case); Docker rejects non-lowercase image names, so `docker compose up` failed on a clean clone. Image name lowercased.

## [1.0.0] - 2026-08-03

- Initial release: Google `customsearch/v1` wire format on top of a self-hosted SearXNG. All 15 web-search CSE parameters, Google's error envelopes, honest lower-bound `totalResults`, stable pagination via a per-query result-set cache, `cx` profiles, optional key auth, Docker Compose stack.
