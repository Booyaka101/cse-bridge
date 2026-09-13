# Changelog

All notable changes to cse-bridge. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [1.2.0] - 2026-09-13

### Added

- **Opt-in `pagemap` reconstruction.** Set `CSE_BRIDGE_PAGEMAP=on` (or `pagemap: true` on a profile, which wins over the environment) and the bridge fetches the result pages themselves and rebuilds a Google-shaped `pagemap` on each item: a `metatags` object from `<meta name|property>` with the key exactly as the page wrote it (`og:title` stays `og:title`, bare `name` attributes are lowercased, as Google does), DataObjects named after the lowercased schema.org type from `application/ld+json` and from microdata `itemtype`, `cse_image` and `cse_thumbnail` as `[{src}]` derived from the first usable of `og:image`, `og:image:secure_url`, `twitter:image` and `twitter:image:src`, and any literal `<PageMap>` block the page publishes. **The key is omitted entirely when nothing parsed**, never an empty object, and no field is ever invented, in particular not `cse_thumbnail` width and height.
- Guardrails on that fetching, all in `src/pagemap.ts`: at most `CSE_BRIDGE_PAGEMAP_MAX` pages per request (default 10, and results that share a page share one fetch), 4 at a time, `CSE_BRIDGE_PAGEMAP_TIMEOUT_MS` per URL (default 3000) plus a whole-pass budget (`CSE_BRIDGE_PAGEMAP_BUDGET_MS`, default 3x the per-URL timeout) so a slow page cannot stall the response, at most 2 redirects, non-HTML content types rejected, a 512 KB body cap that stops reading at `</head>`, and an in-memory LRU keyed by URL with `CSE_BRIDGE_PAGEMAP_TTL_MS` (default 1h). A page that fails, times out or is not reached inside the budget leaves that item bare; the search still returns 200.
- Result pages are third-party URLs, so pagemap refuses loopback, RFC1918, link-local, CGNAT and `.internal`/`.local` hosts. `CSE_BRIDGE_PAGEMAP_ALLOW_PRIVATE=on` lifts that for an intranet index.
- The head reader honours a `<meta charset>` the document declares when the response carries no charset of its own, so a windows-1252 page comes back as `Café` rather than replacement characters. Tag scanning respects quoted attribute values, so a `>` inside `content="if a > b"` does not end the tag early.
- `/healthz` now reports `pagemap: { enabled, maxUrls, cachedPages }`, and the startup banner shows whether pagemap is on.

### Notes

- **Off by default, and byte-identical to 1.1.0 when off.** Verified by running the same seven request shapes against the same fixed backend on both versions and diffing the output.
- What the bridge reconstructs comes from the page, not from Google's index. DataObjects that only existed because Google built them, and `cse_thumbnail` crop dimensions, will not match. See the Limitations section in the README.
- Internal: the expiry-and-size trim shared by the query result-set cache and the new page cache now lives in `src/cache.ts`. No behaviour change, and the byte-identical comparison above was re-run after the extraction.
- The bridge takes Google's documented caps (50 attributes per DataObject, 1024 characters per value) but not its meta-tag exclusion list: Google documents that it drops `description`, yet the live JSON API returns it, so the bridge keeps it. A value over 1024 characters is dropped rather than truncated.

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
