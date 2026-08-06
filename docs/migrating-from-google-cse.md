# Migrating from Google Custom Search JSON API

Google's Custom Search JSON API is [closed to new customers, and existing customers have until **2027-01-01**](https://developers.google.com/custom-search/v1/overview) to move. Google's own suggested successor, Vertex AI Search, is a different API with a different response shape and a paid account.

This document is the per-client recipe for pointing existing code at `cse-bridge` instead. In every case the change is **the endpoint, and nothing else**.

Assumptions below: the bridge is on `http://localhost:8080` and `CSE_BRIDGE_KEYS` is unset, so any `key` value is accepted. Substitute your own host and key as needed.

---

## Contents

- [Node — @googleapis/customsearch](#node--googleapiscustomsearch)
- [Node — googleapis (the monolithic package)](#node--googleapis-the-monolithic-package)
- [Python — google-api-python-client](#python--google-api-python-client)
- [LangChain — GoogleSearchAPIWrapper](#langchain--googlesearchapiwrapper)
- [Go, Java, Ruby, PHP](#go-java-ruby-php)
- [Raw HTTP / curl](#raw-http--curl)
- [What your `cx` becomes](#what-your-cx-becomes)
- [Behaviour differences to check before you cut over](#behaviour-differences-to-check-before-you-cut-over)
- [Troubleshooting](#troubleshooting)

---

## Node — `@googleapis/customsearch`

The client takes `rootUrl` at construction. Note the **trailing slash** — the library concatenates paths onto it.

```js
import { customsearch } from '@googleapis/customsearch';

// Before
const client = customsearch({ version: 'v1' });

// After
const client = customsearch({ version: 'v1', rootUrl: 'http://localhost:8080/' });

const res = await client.cse.list({ q: 'test', cx: 'default', auth: 'k' });
console.log(res.data.items.length);
```

Verified output against a live stack:

```
HTTP status   200
data.kind     customsearch#search
items.length  10
totalResults  20
nextPage      startIndex=11

first item:
  title        Test - Wikipedia
  link         https://en.wikipedia.org/wiki/Test
  displayLink  en.wikipedia.org
```

Errors arrive as normal `googleapis` errors, because the bridge emits Google's envelope:

```js
try {
  await client.cse.list({ q: 'test', cx: 'default', auth: 'k', start: 92 });
} catch (err) {
  err.message; // 'Request contains an invalid argument.'
  err.code;    // 400
}
```

If you set the endpoint from an environment variable, this needs no code change at all:

```js
const client = customsearch({
  version: 'v1',
  ...(process.env.CSE_ROOT_URL ? { rootUrl: process.env.CSE_ROOT_URL } : {}),
});
```

## Node — `googleapis` (the monolithic package)

Same idea, via `google.customsearch`:

```js
import { google } from 'googleapis';

const client = google.customsearch({ version: 'v1', rootUrl: 'http://localhost:8080/' });
const res = await client.cse.list({ q: 'test', cx: 'default', auth: 'k' });
```

---

## Python — `google-api-python-client`

Use `client_options`, which is the documented mechanism:

> "(1) The API endpoint should be set through client_options."
> — [`googleapiclient.discovery.build`](https://googleapis.github.io/google-api-python-client/docs/epy/googleapiclient.discovery-module.html)

No trailing slash here.

```python
from google.api_core.client_options import ClientOptions
from googleapiclient.discovery import build

# Before
service = build("customsearch", "v1", developerKey=API_KEY)

# After
service = build(
    "customsearch", "v1",
    developerKey="k",
    client_options=ClientOptions(api_endpoint="http://localhost:8080"),
)

res = service.cse().list(q="test", cx="default").execute()
print(len(res["items"]))
```

Verified output:

```
kind          customsearch#search
items         10
totalResults  20
nextPage      startIndex=11

first item:
  title        Test - Wikipedia
  link         https://en.wikipedia.org/wiki/Test
  displayLink  en.wikipedia.org
```

Errors raise `HttpError` exactly as before:

```python
from googleapiclient.errors import HttpError

try:
    service.cse().list(q="test", cx="default", start=92).execute()
except HttpError as err:
    print(err.status_code)  # 400
    print(err.reason)       # Request contains an invalid argument.
```

### If you are behind an HTTP proxy

`google-api-python-client` uses `httplib2`, which raises before it ever consults `no_proxy`:

```
httplib2.error.ProxiesUnavailableError: Proxy support missing but proxy use was requested!
```

`httplib2` refuses to run whenever `HTTP_PROXY`/`HTTPS_PROXY` are set and the optional `PySocks` package is absent — the check happens before host bypass is evaluated, so adding `localhost` to `NO_PROXY` does **not** help. Either install `PySocks`, or clear the proxy variables for the process. Your bridge is on localhost; that traffic should not be proxied anyway.

```bash
env -u HTTP_PROXY -u HTTPS_PROXY python your_script.py
```

---

## LangChain — `GoogleSearchAPIWrapper`

`GoogleSearchAPIWrapper` builds its own client inside a model validator and sets `extra="forbid"`, so `client_options` cannot be passed at construction. Override the built client afterwards — one line, and the wrapper class itself is untouched:

```python
from google.api_core.client_options import ClientOptions
from googleapiclient.discovery import build
from langchain_google_community import GoogleSearchAPIWrapper

search = GoogleSearchAPIWrapper(google_api_key="k", google_cse_id="default")

# The endpoint override.
search.search_engine = build(
    "customsearch", "v1",
    developerKey="k",
    client_options=ClientOptions(api_endpoint="http://localhost:8080"),
)

search.run("test")
search.results("rust async runtime", num_results=3)
```

Everything downstream — `GoogleSearchRun`, `GoogleSearchResults`, agent toolkits that take a `GoogleSearchAPIWrapper` — works unchanged, because they all go through `search_engine`.

Verified output of `.results("rust async runtime", num_results=3)`:

```
1. The Async Ecosystem - Asynchronous Programming in Rust
   https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html
2. Fundamentals of Asynchronous Programming: Async, Await ... - Learn Rust
   https://doc.rust-lang.org/book/ch17-00-async-await.html
3. Async in depth | Tokio - An asynchronous Rust runtime
   https://tokio.rs/tokio/tutorial/async
```

`GoogleSearchAPIWrapper` reads `k` results per `.run()` call and `num_results` per `.results()` call. Both are capped at 10 by the bridge, as they are by Google.

---

## Go, Java, Ruby, PHP

All the Google client libraries expose a base/root URL setter. The bridge cares only about the path `\/customsearch\/v1`, so any of these work:

**Go** (`google.golang.org/api/customsearch/v1`):

```go
svc, err := customsearch.NewService(ctx,
    option.WithAPIKey("k"),
    option.WithEndpoint("http://localhost:8080/"),
)
```

**Java** (`google-api-services-customsearch`):

```java
Customsearch cs = new Customsearch.Builder(transport, jsonFactory, null)
    .setApplicationName("app")
    .setRootUrl("http://localhost:8080/")
    .build();
```

**Ruby** (`google-apis-customsearch_v1`):

```ruby
service = Google::Apis::CustomsearchV1::CustomSearchAPIService.new
service.root_url = 'http://localhost:8080/'
service.key = 'k'
```

**PHP** (`google/apiclient`):

```php
$client = new Google\Client();
$client->setDeveloperKey('k');
$client->setConfig('base_path', 'http://localhost:8080');
$service = new Google\Service\CustomSearchAPI($client);
```

These follow the same documented mechanism as the two verified clients above, but are not part of this project's verified acceptance checks.

---

## Raw HTTP / curl

Swap the host. Everything else is identical.

```bash
# Before
curl 'https://www.googleapis.com/customsearch/v1?key=$KEY&cx=$CX&q=widgets&num=3'

# After
curl 'http://localhost:8080/customsearch/v1?key=k&cx=default&q=widgets&num=3'
```

---

## What your `cx` becomes

Your `cx` used to identify a Programmable Search Engine in Google's control panel. Here it selects a named block in `profiles.yml`, so **you keep sending the same `cx`** and decide server-side what it means.

If your old `cx` was `012345678901234567890:abcdefghij` and it only ever searched `docs.example.com`:

```yaml
default:
  categories: [general]

"012345678901234567890:abcdefghij":
  description: Was "Docs PSE" in the Google control panel.
  categories: [general]
  site: docs.example.com
```

Now the untouched client keeps sending its original `cx` and gets site-restricted results.

An unrecognised `cx` falls back to `default` rather than erroring, on the principle that a client you are migrating cannot change the `cx` it sends.

Available profile keys: `engines`, `categories`, `site`, `language`, `description`. All optional.

---

## Behaviour differences to check before you cut over

Go through this list against your own code — these are the places a drop-in swap can still surprise you.

| Area | Google | cse-bridge | Does it matter to you? |
| --- | --- | --- | --- |
| `totalResults` | Estimated web-wide total, often millions | Lower bound of what was actually retrieved; grows as you page | If you **display** it, the number gets much smaller. If you **loop** on it, you are fine. |
| `num > 10` | 400 error | Clamped to 10 | Strictly friendlier. |
| `start > 91` | 400 error | 400 error, identical envelope | No change. |
| Max results | 100 per query | 100 per query | No change. |
| `pagemap` | Present for many results | Absent | Check for `result.get("pagemap")` usage. |
| `searchType=image` | Supported | Supported (v1.1.0+) | `link` is the image, `image.contextLink` the page, as on Google. `imgSize`/`imgType`/`imgColorType`/`imgDominantColor` validate against Google's enums but do not filter — SearXNG has no backend for them. `image.thumbnailWidth`/`thumbnailHeight` are omitted. |
| `spelling` | Google's corrections | Only when SearXNG emits one | Thinner. |
| `sort` | Several sort expressions | Only `date` / `date:a` / `date:d` act | Others are accepted, then ignored. |
| Rate limits | 100 free queries/day, then paid | Whatever your SearXNG and its upstream engines tolerate | You now own this. |
| `promotions`, `context` | Present for some PSEs | Absent | Rarely used. |

### Two shapes to verify in your own code

**`items` is absent, not empty, on zero results** — same as Google. If your code does `for item in res["items"]` without a guard, it already had this bug against Google; it will still have it here.

```python
for item in res.get("items", []):
    ...
```

**Pagination should follow `queries.nextPage`** rather than doing arithmetic, since `nextPage` is omitted on the last page and when the next index would exceed 91:

```python
start = 1
while start:
    res = service.cse().list(q=query, cx=cx, start=start).execute()
    for item in res.get("items", []):
        handle(item)
    nxt = res.get("queries", {}).get("nextPage")
    start = nxt[0]["startIndex"] if nxt else None
```

---

## Troubleshooting

**`503` with "returned HTML, not JSON"**

SearXNG serves JSON only when it is enabled. In `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Then restart SearXNG. Confirm with `curl 'http://localhost:8080/healthz?deep=1'`.

**`503` with "is unreachable"**

`SEARXNG_URL` is wrong or the instance is down. Inside Docker Compose the bridge reaches SearXNG at its **service name** (`http://searxng:8080`), not `localhost`.

**`503` with "refused the request (HTTP 403)"**

SearXNG's limiter or bot detection is blocking the bridge. Set `limiter: false` in `settings.yml` for a private instance, or allow-list the bridge.

**`429` with `RESOURCE_EXHAUSTED`**

Your SearXNG is rate limiting, usually because its upstream engines are. Check `unresponsive_engines` in a direct SearXNG query:

```bash
curl 'http://localhost:8888/search?q=test&format=json' | jq .unresponsive_engines
```

You will often see entries like `["brave", "Suspended: too many requests"]`. Enable more engines, or slow down.

**`403` "The request is missing a valid API key."**

`CSE_BRIDGE_KEYS` is set and your client sent no `key`. Either send one of the listed keys, or unset the variable to disable key checking.

**`400` "API key not valid."**

`CSE_BRIDGE_KEYS` is set and the `key` sent is not in the list.

**Pages overlap**

You have `CSE_BRIDGE_CACHE_TTL_MS=0`, or you paged more slowly than the TTL. A live SearXNG reorders results between calls; the bridge holds a stable result set per query for the TTL so pages stay disjoint. Raise `CSE_BRIDGE_CACHE_TTL_MS` if your paging is slow.

**Results are thin or low quality**

That is your SearXNG's engine configuration, not the bridge. Compare directly:

```bash
curl 'http://localhost:8888/search?q=your+query&format=json' | jq '.results | length'
```
