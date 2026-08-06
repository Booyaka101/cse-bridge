# PROGRESS — cse-bridge

**Status: v1.1.0 PUBLISHED (2026-08-06). All 8 ship-bar points met.**

- GitHub: https://github.com/Booyaka101/cse-bridge — `main` at v1.1.0, tag `v1.1.0` pushed, CI + Guards + Publish all green
- npm: `cse-bridge@1.1.0` — published from this machine as `booyaka`, then verified by installing FROM the registry into a clean dir and serving real image-search traffic
- GHCR: `ghcr.io/booyaka101/cse-bridge:1.1.0` (digest `sha256:20ec6821…`), published by the tag workflow — verified by anonymous pull + run against the live SearXNG

**Publish route, worth remembering:** only `mcp-vet` has an `NPM_TOKEN` repo secret, so this repo's Publish workflow *always* takes its graceful "no NPM_TOKEN secret configured" skip and the npm step shows as `skipped` — that is the designed path, not a failure. npm releases here are `npm publish --access public` from this machine (1.0.x went out the same way). GHCR is the reverse: Actions-only, on any `v*` tag. Registry propagation lagged ~1 min after publish (`npm view` still said 1.0.2) — poll before concluding anything went wrong.

## v1.1.0 — `searchType=image` (2026-08-06)

What shipped, all VERIFIED working:

- **`searchType=image`** end to end: `categories=images` to SearXNG (superseding the profile's categories — documented), `mapImageItem` producing Google's exact item shape (`link` = `img_src`, `image.contextLink` = page URL, width/height from `resolution`, `byteSize` from human-readable `filesize` with 1 KB = 1024, `mime`/`fileFormat` from `img_format` with jpg→jpeg). Anything the engine does not report is omitted, never guessed — including `thumbnailWidth`/`thumbnailHeight`, which SearXNG never has. Results with no `img_src` are dropped, so no item ever pairs `image` with a page link. `searchType` round-trips in `queries.request[0]`.
- **The four image filters** (`imgSize`/`imgType`/`imgColorType`/`imgDominantColor`) validate against Google's exact enums (fetched live from the cse.list reference on build day), reject out-of-enum with Google's 400 envelope, and are inert once accepted — same posture as `sort` beyond `date`.
- **Gallery de-dupe fix** in `fetchWindow`: dedupe now keys on `img_src` when present (ten images on one gallery page used to collapse to one item). Covered by an offline test.
- **Cache separation** image vs web for the same q verified — `cacheKey()` already included categories; a test pins it.
- Tests: **138 offline** (was 109), **142 with `CSE_BRIDGE_LIVE=1`** against the real compose stack — all green. `npm run typecheck` clean.
- Real E2E on build day: `q=red+panda&searchType=image` against the live SearXNG returned real image items in Google's shape (the README's new Image search section shows a real captured response).
- Docs: the README Limitations bullet denying image search is gone, replaced with the honest thumbnail-dimensions note; migration guide row flipped to Supported; CHANGELOG.md created (1.0.0→1.1.0); package.json + package-lock + `VERSION` in src/server.ts all bumped to 1.1.0.
- One test-only fix after a live run: the live image assertion `link !== contextLink` was over-strict — a real engine can serve a bare `.svg` URL as both the image and the page. The offline suite still pins the mapping.

**Published 2026-08-06:** `main` + tag `v1.1.0` pushed (CI, Guards, Publish all green), GHCR built by the tag workflow, npm published locally. Both artifacts verified after the fact against the live SearXNG. Note: a running `docker compose` stack needs `--build` (or a re-pull) to pick up new code — the local stack on 8081 still ran 1.0.2 until then.

- GitHub: https://github.com/Booyaka101/cse-bridge (public, CI green — the `live` job runs the full compose stack on the runner)
- npm: `cse-bridge@1.0.2` (https://www.npmjs.com/package/cse-bridge) — verified by installing from the registry and serving real traffic
- GHCR: `ghcr.io/booyaka101/cse-bridge` `:1.0.2` `:1.0` `:1` `:latest`, multi-arch amd64+arm64, public — verified by anonymous pull + run
- Release: https://github.com/Booyaka101/cse-bridge/releases/tag/v1.0.2

v1.0.1 over v1.0.0: docker-compose.yml shipped `ghcr.io/Booyaka101/...` (mixed case); Docker rejects non-lowercase repo names, so `docker compose up` failed on a clean clone. Caught by CI's live job on the first push.

v1.0.2 over v1.0.1: docs only, no functional change. npm renders the README from the published tarball, so 1.0.1's page still showed the old maintainer-facing "Distribution" section pointing at the archived HN thread; it is now a reader-facing "Further reading and feedback" section. Also synced `package-lock.json`, which had been left at 1.0.0 during the 1.0.1 bump (npm ci tolerated the mismatch, but it was wrong). Verified after publish: `/healthz` on the freshly built container reports `1.0.2`, and an anonymous `docker pull ghcr.io/booyaka101/cse-bridge:1.0.2` runs and serves real search results. Note the VERSION constant in `src/server.ts` must be bumped alongside `package.json` — a plain `docker compose up -d` will NOT pick it up without `--build`.

Publish-day operational notes: npm account `booyaka`, GitHub `Booyaka101`. The publish workflow's npm job skips gracefully when the version already exists or `NPM_TOKEN` is absent (no secret is configured — 1.0.x were published from this machine; add `NPM_TOKEN` to repo secrets to let tags publish npm too). GHCR publishes via the built-in `GITHUB_TOKEN` on any `v*` tag.

Last updated: 2026-08-06

## Distribution (2026-08-03)

| Channel | Status |
| --- | --- |
| dev.to | LIVE — https://dev.to/booyaka101/google-kills-the-custom-search-json-api-on-2027-01-01-here-is-a-self-hosted-drop-in-3nk0 (4 tags, 11 code blocks) |
| X | LIVE — https://x.com/KillKenny101/status/2084261691873742898 (957 chars + GitHub link card) |
| r/selfhosted | LIVE in the weekly New Project Megathread — https://old.reddit.com/r/selfhosted/comments/1vb7psc/new_project_megathread_week_of_30_jul_2026/p1g1hof/ |
| Hacker News | NOT DONE — see below |

**HN thread is archived (README now fixed in 1.0.2).** HN archives threads after ~14 days, and `item?id=48942250` is archived (no comment form). The live route is a Show HN, but the `Booyaka101` HN account has **3 karma** and `/submit` bounces with "You're posting too fast" (`fnop=story-toofast`) — needs aged karma or an owner-driven submission.

**r/selfhosted rule 6:** standalone new-project posts are removed (the first attempt was, by u/asimovs-auditor) — projects must go in the weekly "New Project Megathread". Note the Reddit account has 1 karma and old.reddit's `/submit` serves it a reCAPTCHA challenge; new-reddit's composer works.

Post drafts kept at `D:\tmp\cse-marketing\content\` (devto.md, x.txt, reddit.md, reddit-megathread.md).

## Pre-publish cold-start verification (2026-08-03, second pass)

Simulated a stranger's fresh clone: copied ONLY the repo files (no `.env`, `node_modules`, `dist`, `verify/`) to a temp dir, then:

- `docker compose up -d --build` from clean → both containers healthy, `/healthz?deep=1` confirms `format=json` enabled purely from the committed `searxng/settings.yml`. The README's port-taken recipe (`CSE_BRIDGE_HOST_PORT` in `.env`) works as written.
- `npm ci` + typecheck + `CSE_BRIDGE_LIVE=1 npm test` → **112/112 pass** from the clean checkout.
- Worked example, `start=1/11/21` disjointness (30/30 unique), `start=92` envelope, zero-results shape — all PASS against the cold stack.
- All three real clients re-run against the cold stack: `@googleapis/customsearch`, `google-api-python-client`, LangChain `GoogleSearchAPIWrapper` — all PASS.
- `npm publish --dry-run` succeeds (34.2 kB, 22 files); tarball installed into a cleanroom; `npx cse-bridge --version` works; the installed bin served real search traffic (byte-checked: no BOM, valid JSON).
- **npm name `cse-bridge` is FREE** (registry returns E404).

Temp dirs removed; project stack restored on port 8081.

---

## Phase 0 — external resource verification (all PASSED, nothing blocked)

Every resource was re-fetched live before any code was written.

| Resource | Verified |
| --- | --- |
| `developers.google.com/custom-search/v1/overview` | Verbatim: *"The Custom Search JSON API is closed to new customers. Existing Custom Search JSON API customers have until January 1, 2027 to transition to an alternative solution."* Plus *"100 search queries per day for free"* and Vertex AI Search as the successor. **K1 proof holds.** |
| `api.npmjs.org/.../@googleapis/customsearch` | 64,040 downloads, 2026-07-04 → 2026-08-02. (Brief said 64,840 for a window one day earlier — same order of magnitude, the stranded-population claim holds.) |
| `searxng/searx/webutils.py` on master | `get_json_response` builds exactly `{query, results, answers, corrections, infoboxes, suggestions, unresponsive_engines}`. **`number_of_results` appears nowhere in the file** — confirmed, so `totalResults` must be synthesized. |
| `docs.searxng.org/dev/search_api.html` | *"Format needs to be activated in `search:`"*. Params confirmed: `q, categories, engines, language, pageno, time_range, format, safesearch, theme`. |
| `googleapis.github.io/.../discovery-module.html` | *"(1) The API endpoint should be set through client_options."* |
| `github.com/brcrusoe72/agent-search` | Live, MIT, 62★/7 forks, pushed 2026-08-03. README confirms a **bespoke `/search` API on :3939**, not `/customsearch/v1`. Different product; our positioning holds. |
| `github.com/rondeo-balos/tp-custom-search-api` | 0★, 0 forks, created 2025-12-12, last push 2025-12-14, **license: none (all rights reserved)**. `app/scraper.py` read as a negative oracle only; nothing copied. All four of its defects confirmed and covered by tests. |
| `news.ycombinator.com/item?id=48942250` | Live, 53 points. Quote confirmed: *"I was using it for an ai agent i built for my use as home assistant."* Alternatives named: Vertex AI Search, Kagi, Brave, SearXNG, SerpApi, SearchApi, Serper, cloro. |

**Cost model: $0.** No paid API key, no account, no paid hosting. Docker Desktop (already installed, free for personal use) + `searxng/searxng` (AGPL, free) + Node. Nothing was signed up for; no payment details entered.

**LESSONS.md**: read. No entry contradicts this brief. Applied: non-dot scratch folder + verify `package.json` exists before `npm install` (#23), and one new fact appended (httplib2/proxy — see below).

---

## What was built and VERIFIED WORKING

### Real end-to-end run
`docker compose up -d` → SearXNG + bridge, both healthy. The brief's worked example returned real results from real engines in Google's exact shape (full body in the final summary and README). `displayLink` = `rust-lang.github.io` (no scheme, no path); all eight item fields non-empty; `searchInformation.totalResults` parses as an integer ≥ 3.

### Acceptance checks — all 5 PASS

| # | Check | Result |
| --- | --- | --- |
| 1 | `node --test` green | **112 pass / 0 fail** (109 offline + 3 live) |
| 2 | Unmodified `@googleapis/customsearch`, `rootUrl` override only | PASS — `items.length` 10, kind correct, page 2 disjoint, `start=92` throws a normal googleapis 400 |
| 3 | Unmodified `google-api-python-client` + `ClientOptions(api_endpoint=...)` | PASS — 10 items, `HttpError` 400 on `start=92` |
| 4 | LangChain `GoogleSearchAPIWrapper` via endpoint override | PASS — `.run()` and `.results(num_results=3)` both return real results |
| 5 | `start=1, 11, 21` disjoint | PASS — 30 links, 30 unique, against a **live** instance |

Verification scripts live in `verify/` (gitignored — scratch, not part of the package).

### Edge cases — every one has a test AND was exercised live

- `num > 10` clamps to 10 (live: `num=50` → 10 items)
- `start > 91` → Google's exact envelope, `INVALID_ARGUMENT` / `badRequest`
- Zero results → `items` key **absent**, `totalResults` `"0"` (live-confirmed)
- `totalResults` synthesized as a lower bound, never `"0"` with items, grows 20→30→40 while paging, never `len*100`
- SearXNG 429 → 429 `RESOURCE_EXHAUSTED`
- SearXNG unreachable → 503 `UNAVAILABLE` (live-confirmed by stopping the container)
- SearXNG serving HTML → 503 naming the exact `settings.yml` fix
- SearXNG 403 → 503 naming limiter/botdetection
- Unknown `cx` → default profile (live-confirmed)
- `key` checked only when `CSE_BRIDGE_KEYS` is set; missing → 403 `PERMISSION_DENIED`, wrong → 400 `INVALID_ARGUMENT`

### Two defects found and fixed during the build

1. **A page past the end of the results reported a non-zero `totalResults`** (`start-1+0`). Caught by a test; now returns `0`.
2. **Live pages overlapped: 30 links, 28 unique.** SearXNG reorders results between identical calls (engines have varying latency, some drop out), so paging straight through re-served links. Fixed with a per-query result-set cache (`CSE_BRIDGE_CACHE_TTL_MS`, default 300s) that resolves a query to a stable ordered set and pages within it — the way Google behaves. Re-measured: **30 links, 30 unique.** Backend walks are also serialized per query so concurrent cold-cache pages cannot race into competing result sets. Both behaviours are covered by tests, including one that proves the *uncached* path really does overlap.

Bonus fix: `/healthz` originally ran a real search, which the 30s container healthcheck would have fired ~2,880 times a day at upstream engines. It is now a cheap liveness probe, with `?deep=1` for the full `format=json` verification.

---

## Ship-bar checklist

1. **Feature-complete** — YES. All 15 CSE params, both endpoints, full `customsearch#search` mapping, profiles, auth, pagination. No TODO/FIXME/placeholder on any user path (scanned).
2. **No mocks/placeholders/fake data** — YES. The shipped product queries a real SearXNG. Fakes exist only inside `test/`.
3. **Real end-to-end run** — YES. Done twice: via Docker Compose, and via the npm tarball installed into a cleanroom directory.
4. **Handles reality** — YES. Bad input, missing params, empty results, backend down, backend timeout, backend HTML, backend 403, backend 429, port in use, malformed config, missing profiles file — all produce clear messages, never a stack trace.
5. **Tests** — YES. 112 passing. `npm test` (offline). `CSE_BRIDGE_LIVE=1 SEARXNG_URL=http://localhost:8888 npm test` adds live checks.
6. **Publish-ready packaging** — YES. `package.json` complete (name, description, 1.0.0, MIT, author, repo, keywords, bin, exports, engines, files). Real `.gitignore`, `.dockerignore`, `LICENSE`. **Verified: `npm pack` → install into a clean dir → `cse-bridge --version` → server starts and serves real traffic.** Tarball is 22 files, zero runtime deps.
7. **README** — YES. Leads with the 2027-01-01 shutdown and Google's verbatim notice, compose quickstart on the first screen, real unedited output, all four client recipes, configuration table, limitations, and the distribution step.
8. **Version 1.0.0** — YES.

---

## Not done (deliberately — owner ships from the phone)

- **Not published to npm.** Run `npm publish --access public`, or push a `v1.0.0` tag to fire `.github/workflows/publish.yml`.
- **Not pushed to GHCR.** Same workflow builds and pushes `ghcr.io/<repo>:1.0.0` on tag (multi-arch amd64+arm64, uses the built-in `GITHUB_TOKEN`).
- **No git repo initialised.** The project folder is not a git repo yet.
- **Repo URL is a guess** — `package.json`, `Dockerfile` label and `docker-compose.yml` image name all say `Booyaka101/cse-bridge`. Change these three if the repo lands elsewhere.
- **`NPM_TOKEN` secret** must be added to the GitHub repo before the npm job can run.

## If you pick this up again

Everything is verified working; there is no half-finished work. Sensible next moves, in order:

1. `git init`, commit, push to `github.com/Booyaka101/cse-bridge`.
2. Add the `NPM_TOKEN` secret, tag `v1.0.0`, let the workflow publish both artifacts.
3. Post to the HN thread (`item?id=48942250`) — see the README's distribution section.
4. Possible future work, out of scope so far: `pagemap` extraction from SearXNG's engine-specific extras, a `siterestrict` alias endpoint, and per-`cx` rate limits. (`searchType=image` shipped in v1.1.0.)

To bring the stack back up: `docker compose up -d` (put `CSE_BRIDGE_HOST_PORT=8081` in `.env` if 8080 is busy on this machine — it currently is).
