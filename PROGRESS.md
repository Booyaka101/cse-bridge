# PROGRESS — cse-bridge

**Status: v1.0.0 COMPLETE. All 8 ship-bar points met. Not published (owner ships from phone).**

Last updated: 2026-08-03

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
4. Possible v1.1 work, all out of scope for v1: `searchType=image`, `pagemap` extraction from SearXNG's engine-specific extras, a `siterestrict` alias endpoint, and per-`cx` rate limits.

To bring the stack back up: `docker compose up -d` (put `CSE_BRIDGE_HOST_PORT=8081` in `.env` if 8080 is busy on this machine — it currently is).
