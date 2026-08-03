# cse-bridge

**Google is shutting off the Custom Search JSON API on 2027-01-01. This keeps your code running by changing one base URL.**

> "The Custom Search JSON API is closed to new customers. Existing Custom Search JSON API customers have until January 1, 2027 to transition to an alternative solution."
> — [Google, Custom Search JSON API overview](https://developers.google.com/custom-search/v1/overview)

Google's suggested replacement is Vertex AI Search — a different API, a different response shape, and a paid product. Every line you wrote against `customsearch/v1` has to be rewritten.

`cse-bridge` is the other option: a small self-hosted HTTP service that speaks Google's `customsearch/v1` **wire format** on top of your own [SearXNG](https://github.com/searxng/searxng) instance. Your client library, your parsing code, your pagination loop and your `cx` values all stay exactly as they are.

```diff
- customsearch({version: 'v1'})
+ customsearch({version: 'v1', rootUrl: 'http://localhost:8080/'})
```

No API keys. No per-query fees. No account. It is your machine talking to your SearXNG.

---

## Quickstart

```bash
git clone https://github.com/Booyaka101/cse-bridge.git
cd cse-bridge
docker compose up -d
```

That is the whole install. Now make the call you were already making:

(A prebuilt image is also on GHCR — `ghcr.io/booyaka101/cse-bridge` — which the compose file uses automatically once pulled; `docker compose up -d` builds locally either way.)

```bash
curl 'http://localhost:8080/customsearch/v1?key=k&cx=default&q=rust%20async%20runtime&num=3'
```

```json
{
  "kind": "customsearch#search",
  "url": {
    "type": "application/json",
    "template": "https://www.googleapis.com/customsearch/v1?q={searchTerms}&num={count?}&start={startIndex?}&cx={cx?}"
  },
  "queries": {
    "request": [
      {
        "title": "Google Custom Search - rust async runtime",
        "totalResults": "6",
        "searchTerms": "rust async runtime",
        "count": 3,
        "startIndex": 1,
        "inputEncoding": "utf8",
        "outputEncoding": "utf8",
        "safe": "off",
        "cx": "default"
      }
    ],
    "nextPage": [ { "startIndex": 4, "count": 3, "...": "..." } ]
  },
  "searchInformation": {
    "searchTime": 1.409902324,
    "formattedSearchTime": "1.41",
    "totalResults": "6",
    "formattedTotalResults": "6"
  },
  "items": [
    {
      "kind": "customsearch#result",
      "title": "The Async Ecosystem - Asynchronous Programming in Rust",
      "htmlTitle": "The Async Ecosystem - Asynchronous Programming in Rust",
      "link": "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
      "displayLink": "rust-lang.github.io",
      "snippet": "The Async Ecosystem Rust currently provides only the bare essentials for writing async code. Importantly, executors, tasks, reactors, combinators, and low-level I/O futures and traits are not yet provided in the standard library. ...",
      "htmlSnippet": "The Async Ecosystem Rust currently provides only the bare essentials for writing async code. ...",
      "formattedUrl": "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
      "htmlFormattedUrl": "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html"
    }
  ]
}
```

That is a real, unedited response from the stack above. Real results, from real engines, in Google's shape.

> **Port 8080 already taken?** Put `CSE_BRIDGE_HOST_PORT=8081` in a `.env` next to `docker-compose.yml`.

---

## Does my client actually work unchanged?

These four are verified end to end against a live stack. Full recipes in [docs/migrating-from-google-cse.md](docs/migrating-from-google-cse.md).

**Node — `@googleapis/customsearch`**

```js
import { customsearch } from '@googleapis/customsearch';

const client = customsearch({ version: 'v1', rootUrl: 'http://localhost:8080/' });
const res = await client.cse.list({ q: 'test', cx: 'default', auth: 'k' });
console.log(res.data.items.length); // 10
```

**Python — `google-api-python-client`**

```python
from google.api_core.client_options import ClientOptions
from googleapiclient.discovery import build

service = build("customsearch", "v1", developerKey="k",
                client_options=ClientOptions(api_endpoint="http://localhost:8080"))
res = service.cse().list(q="test", cx="default").execute()
print(len(res["items"]))  # 10
```

**LangChain — `GoogleSearchAPIWrapper`**

```python
search = GoogleSearchAPIWrapper(google_api_key="k", google_cse_id="default")
search.search_engine = build("customsearch", "v1", developerKey="k",
                             client_options=ClientOptions(api_endpoint="http://localhost:8080"))
search.run("test")
```

**curl / anything else** — swap `https://www.googleapis.com` for `http://localhost:8080`.

---

## Install without Docker

You need a SearXNG instance with JSON output enabled (see below).

```bash
npm install -g cse-bridge
SEARXNG_URL=http://localhost:8888 cse-bridge
```

```
cse-bridge 1.0.0
  listening   http://localhost:8080
  endpoint    http://localhost:8080/customsearch/v1
  backend     http://localhost:8888
  profiles    default, docs, news, code (from profiles.yml)
  auth        disabled (any key accepted)
```

Requires Node 22 or newer. The package has **zero runtime dependencies**.

---

## The one thing SearXNG needs

SearXNG does not serve JSON unless you turn it on. From [the SearXNG search API docs](https://docs.searxng.org/dev/search_api.html): *"Format needs to be activated in `search:`"*. In `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

The bundled `searxng/settings.yml` already does this, so `docker compose up` just works. If you point at your own instance and forget, the bridge tells you exactly what to fix instead of failing mysteriously:

```json
{"error":{"code":503,"message":"The service is currently unavailable.","errors":[{"message":"SearXNG at http://localhost:8888 returned HTML, not JSON. Enable it in settings.yml:\n  search:\n    formats:\n      - html\n      - json","domain":"global","reason":"backendError"}],"status":"UNAVAILABLE"}}
```

---

## Configuration

All configuration is environment variables. Every one has a working default.

| Variable | Default | What it does |
| --- | --- | --- |
| `SEARXNG_URL` | `http://localhost:8888` | Your SearXNG instance. Must have `json` in `search.formats`. |
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `CSE_BRIDGE_KEYS` | *(unset)* | Comma-separated accepted `key` values. **Unset means the `key` param is not checked at all.** |
| `PROFILES_FILE` | `profiles.yml` | `cx` → backend profile map. A missing file is fine. |
| `CSE_BRIDGE_TIMEOUT_MS` | `20000` | Per-request backend timeout. |
| `CSE_BRIDGE_CACHE_TTL_MS` | `300000` | How long a query's result set stays stable. `0` disables caching — see [Pagination](#pagination-and-why-there-is-a-cache). |
| `CSE_BRIDGE_CACHE_MAX` | `256` | Max distinct queries held in the cache. |

### Profiles: what your `cx` means now

Google's `cx` identified a Programmable Search Engine. Here it selects a block in `profiles.yml`, so a client you cannot edit keeps sending its existing `cx` and **you** decide server-side what it searches:

```yaml
default:
  description: General web search across the instance's enabled engines.
  categories: [general]

docs:
  categories: [general]
  site: docs.rs          # every query on this cx gets an implicit site: filter

news:
  categories: [news]
```

An unknown `cx` falls back to `default` — never an error, because a migrating client cannot change the `cx` it sends.

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /customsearch/v1` | The Google-shaped search endpoint. |
| `GET /healthz` | Liveness plus backend reachability. |
| `GET /healthz?deep=1` | Also runs a real query, proving `format=json` is enabled. |

`/healthz` deliberately does *not* search — a 30-second container healthcheck firing real queries would get your instance rate-limited by upstream engines.

---

## Supported parameters

`key`, `cx`, `q`, `num`, `start`, `hl`, `lr`, `safe`, `siteSearch`, `siteSearchFilter`, `dateRestrict`, `fileType`, `exactTerms`, `excludeTerms`, `sort`.

A few behaviours are worth knowing:

- **`num` above 10 clamps to 10** instead of erroring. Google rejects it; clamping is friendlier and keeps `start=1,11,21` loops walking.
- **`start` above 91 returns Google's exact error envelope**, including `status: "INVALID_ARGUMENT"` and `errors[0].reason: "badRequest"`.
- **`dateRestrict`** (`d7`, `m6`, …) maps onto SearXNG's coarser `day`/`week`/`month`/`year` buckets, always rounding **up** — you get a superset of what you asked for, never a subset.
- **`siteSearch`, `fileType`, `exactTerms`, `excludeTerms`** become search operators in the backend query, since SearXNG has no dedicated parameters for them.
- **`sort=date`** reorders by the `publishedDate` SearXNG attaches to news and paper results; undated results keep their relevance order and sit last.

---

## Pagination, and why there is a cache

This is the part that quietly breaks naive implementations.

SearXNG merges several engines into each page, and those engines have varying latency — some drop out entirely. Ask the same query twice, seconds apart, and the results come back **in a different order**. Page straight through and `start=11` re-serves links that `start=1` already showed.

Measured against a live instance without a cache: `start=1,11,21` returned 30 links, only **28 unique**.

So `cse-bridge` resolves a query to a stable, de-duplicated result set and pages *within* it for `CSE_BRIDGE_CACHE_TTL_MS` — the way Google behaves. With the cache on, the same three requests return **30 links, 30 unique**. A cached deep page also costs zero backend calls.

Set `CSE_BRIDGE_CACHE_TTL_MS=0` to disable it, and expect overlapping pages.

## `totalResults` is honest

SearXNG's JSON payload is exactly `{query, results, answers, corrections, infoboxes, suggestions, unresponsive_engines}` — verified in [`get_json_response`](https://github.com/searxng/searxng/blob/master/searx/webutils.py). **There is no result-count field.** Anything a bridge reports as `totalResults` is synthesized.

`cse-bridge` reports a **lower bound**: everything it has actually walked past, plus one more page's worth only when a next page genuinely exists. It grows monotonically as you page (20 → 30 → 40) so `while start < totalResults` loops keep advancing, and it is never `"0"` while `items` exist.

It is not a real total, and it does not pretend to be. What it will never do is invent one — the obvious wrong answer is `len(results) * 100`, which sends clients paging into empty space.

---

## Limitations

Worth knowing before you migrate:

- **`totalResults` is a lower bound, not an estimate of the web.** If your code displays "about 1,240,000 results", it will now show a much smaller honest number.
- **100 results maximum per query** (`start` ≤ 91), same as Google.
- **No `pagemap`**, no structured data, no rich snippets. SearXNG does not extract them.
- **No image search**, no `searchType=image`.
- **No `spelling` unless SearXNG produces a correction**; it is thinner than Google's.
- **Result quality is your SearXNG's**, not Google's. Which engines are enabled, and whether they are being rate-limited, decides what you get. Check `unresponsive_engines` on your instance if results look thin.
- **`sort` beyond `date`** is accepted and validated but has no backend to act on.
- **Not a Google account substitute.** Nothing here talks to Google.

---

## Running the tests

```bash
npm install
npm test
```

```
# tests 109
# suites 28
# pass 109
# fail 0
```

Node's built-in test runner, no framework. The suite runs fully offline against a fake backend. To also run the live checks against a real instance:

```bash
docker compose up -d
CSE_BRIDGE_LIVE=1 SEARXNG_URL=http://localhost:8888 npm test
```

---

## Prior art

[`brcrusoe72/agent-search`](https://github.com/brcrusoe72/agent-search) also wraps SearXNG, but exposes its own `/search` API for AI agents — a different shape, requiring code changes. `cse-bridge` exists for the opposite case: you have code you do **not** want to change.

[`rondeo-balos/tp-custom-search-api`](https://github.com/rondeo-balos/tp-custom-search-api) is an abandoned, unlicensed 270-line prototype of this same idea. It is worth reading as a list of what to get right: it computes `totalResults` from a `number_of_results` key that does not exist in SearXNG's JSON (falling back to a fabricated `len(results) * 100`), emits no `nextPage`/`previousPage`, copies `htmlTitle`/`htmlSnippet` through unescaped, and validates neither `num` nor `start`. All four are covered by tests here.

---

## Further reading and feedback

- **[Why `totalResults` and pagination are the hard parts](https://dev.to/booyaka101/google-kills-the-custom-search-json-api-on-2027-01-01-here-is-a-self-hosted-drop-in-3nk0)** — a longer write-up of the two problems above, with the measurements.
- Discussion on [r/selfhosted](https://old.reddit.com/r/selfhosted/comments/1vb7psc/new_project_megathread_week_of_30_jul_2026/p1g1hof/).
- Background: the [Hacker News thread on the shutdown](https://news.ycombinator.com/item?id=48942250) is worth reading for what people are migrating to. Note it is archived, so you cannot reply to it.

**The most useful thing you can report:** a client library that will *not* accept an endpoint override. The whole premise of this project is that yours will — Node, Python and LangChain are verified, and the others in [the migration guide](docs/migrating-from-google-cse.md#go-java-ruby-php) follow the same documented mechanism but are not covered by the acceptance checks. If you hit one that can't be repointed, please [open an issue](https://github.com/Booyaka101/cse-bridge/issues); that is the case that breaks the premise and I want to know about it.

Bug reports, missing CSE parameters, and SearXNG engine configurations that produce noticeably better results are all welcome.

---

## License

MIT — see [LICENSE](LICENSE).
