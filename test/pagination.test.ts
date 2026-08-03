/**
 * Pagination is where a naive bridge quietly breaks every consumer: SearXNG
 * merges several engines into pages whose boundaries do not line up with
 * Google's fixed 10-per-page windows. Passing `start` straight through as a
 * page number both overlaps and skips.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SearxngClient, type SearxngResult } from '../src/searxng.ts';
import { mapResponse } from '../src/map.ts';
import type { CseParams } from '../src/params.ts';

const params = (over: Partial<CseParams> = {}): CseParams => ({
  key: 'k',
  cx: 'default',
  q: 'test',
  num: 10,
  start: 1,
  hl: undefined,
  lr: undefined,
  safe: 'off',
  siteSearch: undefined,
  siteSearchFilter: undefined,
  dateRestrict: undefined,
  fileType: undefined,
  exactTerms: undefined,
  excludeTerms: undefined,
  sort: undefined,
  ...over,
});

/**
 * A fake SearXNG whose page size deliberately does NOT match Google's 10, and
 * which repeats some results across pages the way real merged engines do.
 */
function fakeSearxng(opts: { total: number; pageSize: number; duplicateEvery?: number }): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const pageno = Number(url.searchParams.get('pageno') ?? '1');
    const first = (pageno - 1) * opts.pageSize;
    const results: SearxngResult[] = [];
    for (let i = first; i < Math.min(first + opts.pageSize, opts.total); i++) {
      results.push({
        url: `https://example.com/r/${i + 1}`,
        title: `Result ${i + 1}`,
        content: `Content ${i + 1}`,
        engine: 'fake',
      });
    }
    // Real instances repeat a result across pages when engines disagree.
    if (opts.duplicateEvery && pageno > 1 && results.length > 0) {
      results.unshift({
        url: `https://example.com/r/${Math.max(1, first)}`,
        title: `Result ${Math.max(1, first)}`,
        content: 'duplicate',
        engine: 'fake2',
      });
    }
    const body = {
      query: url.searchParams.get('q'),
      results,
      answers: [],
      corrections: [],
      infoboxes: [],
      suggestions: [],
      unresponsive_engines: [],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function client(opts: { total: number; pageSize: number; duplicateEvery?: number }): SearxngClient {
  return new SearxngClient({
    baseUrl: 'http://searxng.test',
    timeoutMs: 5000,
    fetchImpl: fakeSearxng(opts),
  });
}

async function page(c: SearxngClient, start: number, num = 10) {
  const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, start, num);
  return { links: window.map((r) => r.url), hasMore };
}

describe('start=1, 11, 21 return disjoint link sets', () => {
  test('with a backend page size of 10', async () => {
    const c = client({ total: 100, pageSize: 10 });
    const p1 = await page(c, 1);
    const p2 = await page(c, 11);
    const p3 = await page(c, 21);

    assert.equal(p1.links.length, 10);
    assert.equal(p2.links.length, 10);
    assert.equal(p3.links.length, 10);

    const all = [...p1.links, ...p2.links, ...p3.links];
    assert.equal(new Set(all).size, 30, 'the three pages must not share a single link');
  });

  test('with a backend page size of 23, which lines up with nothing', async () => {
    const c = client({ total: 100, pageSize: 23 });
    const p1 = await page(c, 1);
    const p2 = await page(c, 11);
    const p3 = await page(c, 21);
    const all = [...p1.links, ...p2.links, ...p3.links];
    assert.equal(new Set(all).size, 30);
    // And contiguous: no result is skipped between pages either.
    assert.deepEqual(all, Array.from({ length: 30 }, (_, i) => `https://example.com/r/${i + 1}`));
  });

  test('with a backend that repeats results across pages', async () => {
    const c = client({ total: 100, pageSize: 7, duplicateEvery: 1 });
    const p1 = await page(c, 1);
    const p2 = await page(c, 11);
    const p3 = await page(c, 21);
    const all = [...p1.links, ...p2.links, ...p3.links];
    assert.equal(new Set(all).size, 30, 'duplicates from the backend must be collapsed, not paged through twice');
  });

  test('the full 1..91 ladder never repeats a link', async () => {
    const c = client({ total: 100, pageSize: 11 });
    const seen = new Set<string>();
    let count = 0;
    for (const start of [1, 11, 21, 31, 41, 51, 61, 71, 81, 91]) {
      const p = await page(c, start);
      for (const link of p.links) {
        assert.ok(!seen.has(link), `${link} appeared twice across the ladder`);
        seen.add(link);
        count++;
      }
    }
    assert.equal(count, 100);
    assert.equal(seen.size, 100);
  });
});

describe('nextPage / previousPage', () => {
  test('nextPage is present on a full page with more behind it', async () => {
    const c = client({ total: 100, pageSize: 10 });
    const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    const body = mapResponse({ params: params(), results: window, hasMore, searchTime: 0.1 });
    assert.ok(body.queries.nextPage, 'clients read queries.nextPage[0].startIndex to page');
    assert.equal(body.queries.nextPage![0]!.startIndex, 11);
    assert.equal(body.queries.nextPage![0]!.count, 10);
    assert.equal(body.queries.previousPage, undefined, 'there is no page before the first');
  });

  test('previousPage appears from the second page on', async () => {
    const c = client({ total: 100, pageSize: 10 });
    const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 21, 10);
    const body = mapResponse({ params: params({ start: 21 }), results: window, hasMore, searchTime: 0.1 });
    assert.equal(body.queries.previousPage![0]!.startIndex, 11);
    assert.equal(body.queries.nextPage![0]!.startIndex, 31);
  });

  test('nextPage is omitted on the last, partial page', async () => {
    const c = client({ total: 15, pageSize: 10 });
    const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 11, 10);
    assert.equal(window.length, 5);
    const body = mapResponse({ params: params({ start: 11 }), results: window, hasMore, searchTime: 0.1 });
    assert.equal(body.queries.nextPage, undefined);
    assert.equal(body.searchInformation.totalResults, '15');
  });

  test('nextPage is omitted when it would point past start=91', async () => {
    const c = client({ total: 200, pageSize: 25 });
    const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 91, 10);
    assert.equal(window.length, 10);
    const body = mapResponse({ params: params({ start: 91 }), results: window, hasMore, searchTime: 0.1 });
    assert.equal(body.queries.nextPage, undefined, 'start=101 is not a requestable page');
    assert.equal(body.queries.previousPage![0]!.startIndex, 81);
  });

  test('a client that follows nextPage walks the whole result set exactly once', async () => {
    const c = client({ total: 55, pageSize: 9 });
    const seen: string[] = [];
    let start: number | undefined = 1;
    let guard = 0;
    while (start !== undefined && guard++ < 20) {
      const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, start, 10);
      const body = mapResponse({ params: params({ start }), results: window, hasMore, searchTime: 0.1 });
      for (const item of body.items ?? []) seen.push(item.link);
      start = body.queries.nextPage?.[0]?.startIndex;
    }
    assert.equal(seen.length, 55);
    assert.equal(new Set(seen).size, 55);
  });
});

describe('backend exhaustion', () => {
  test('a start beyond the available results yields zero items, not an error', async () => {
    const c = client({ total: 12, pageSize: 10 });
    const { window, hasMore } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 21, 10);
    assert.equal(window.length, 0);
    assert.equal(hasMore, false);
    const body = mapResponse({ params: params({ start: 21 }), results: window, hasMore, searchTime: 0.1 });
    assert.equal(body.items, undefined);
    assert.equal(body.searchInformation.totalResults, '0');
  });

  test('walking stops once the backend stops producing new results', async () => {
    const c = client({ total: 5, pageSize: 10 });
    const { pagesFetched, window } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    assert.equal(window.length, 5);
    assert.ok(pagesFetched <= 2, `should not keep hammering an exhausted backend, fetched ${pagesFetched} pages`);
  });

  test('the page walk is bounded even against an endless backend', async () => {
    const c = new SearxngClient({
      baseUrl: 'http://searxng.test',
      timeoutMs: 5000,
      maxPages: 3,
      cacheTtlMs: 0,
      fetchImpl: fakeSearxng({ total: 10_000, pageSize: 2 }),
    });
    const { pagesFetched } = await c.fetchWindow({ query: 'test', safesearch: 0 }, 91, 10);
    assert.equal(pagesFetched, 3);
  });
});

/**
 * A live SearXNG returns the SAME query in a DIFFERENT order seconds apart,
 * because its engines have varying latency and some drop out. Without a stable
 * result set, `start=11` re-serves links `start=1` already showed. This was
 * measured against a real instance: 30 links, only 28 unique.
 */
describe('result-set stability across requests', () => {
  /**
   * A backend that reshuffles between calls, like a real one. Each call rotates
   * the corpus by a page's worth, which is exactly the observed live failure:
   * a result that was on page 1 slips onto page 2 and gets served twice.
   */
  function shufflingBackend(total: number, pageSize: number, drift = 10): { impl: typeof fetch; calls: () => number } {
    let call = 0;
    const impl: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      call++;
      const pageno = Number(url.searchParams.get('pageno') ?? '1');
      const ids = Array.from({ length: total }, (_, i) => (((i - call * drift) % total) + total) % total + 1);
      const slice = ids.slice((pageno - 1) * pageSize, pageno * pageSize);
      return new Response(
        JSON.stringify({
          query: url.searchParams.get('q'),
          results: slice.map((id) => ({
            url: `https://example.com/r/${id}`,
            title: `Result ${id}`,
            content: `Content ${id}`,
            engine: 'shuffle',
          })),
          answers: [],
          corrections: [],
          infoboxes: [],
          suggestions: [],
          unresponsive_engines: [],
        }),
        { status: 200 },
      );
    };
    return { impl, calls: () => call };
  }

  test('caching keeps start=1/11/21 disjoint even when the backend reshuffles', async () => {
    const { impl } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    const all: string[] = [];
    for (const start of [1, 11, 21]) {
      const { window } = await c.fetchWindow({ query: 'test', safesearch: 0 }, start, 10);
      assert.equal(window.length, 10);
      all.push(...window.map((r) => r.url));
    }
    assert.equal(new Set(all).size, 30, 'a reshuffling backend must not produce overlapping pages');
  });

  test('without the cache the same backend DOES overlap — this is what the cache buys', async () => {
    const { impl } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, cacheTtlMs: 0, fetchImpl: impl });
    const all: string[] = [];
    for (const start of [1, 11, 21]) {
      const { window } = await c.fetchWindow({ query: 'test', safesearch: 0 }, start, 10);
      all.push(...window.map((r) => r.url));
    }
    assert.ok(new Set(all).size < 30, 'sanity check: the shuffling backend really does cause overlap');
  });

  test('a cached deep page costs zero backend calls', async () => {
    const { impl, calls } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    const afterFirst = calls();
    const second = await c.fetchWindow({ query: 'test', safesearch: 0 }, 11, 10);
    assert.equal(second.pagesFetched, 0);
    assert.equal(second.cached, true);
    assert.equal(calls(), afterFirst, 'page 2 was already covered by the cached result set');
  });

  test('a deeper page extends the cached set instead of restarting it', async () => {
    const { impl, calls } = shufflingBackend(400, 10, 1);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    const first = await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    const prefix = first.results.slice(0, 10).map((r) => r.url);
    const afterFirst = calls();

    const deep = await c.fetchWindow({ query: 'test', safesearch: 0 }, 81, 10);
    assert.equal(deep.window.length, 10);
    assert.ok(calls() > afterFirst, 'a deeper window does need more backend pages');
    // The already-collected prefix survived: the walk resumed, it did not
    // restart and re-shuffle the results a client has already been shown.
    assert.deepEqual(deep.results.slice(0, 10).map((r) => r.url), prefix);
    // And page 1's window is still byte-identical after the extension.
    const again = await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    assert.deepEqual(again.window.map((r) => r.url), prefix);
  });

  test('different queries never share a result set', async () => {
    const { impl } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    const a = await c.fetchWindow({ query: 'alpha', safesearch: 0 }, 1, 10);
    const b = await c.fetchWindow({ query: 'beta', safesearch: 0 }, 1, 10);
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
    assert.equal(c.cacheSize, 2);
  });

  test('every backend-affecting parameter is part of the cache identity', async () => {
    const { impl } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    const base = { query: 'q', safesearch: 0 } as const;
    await c.fetchWindow(base, 1, 10);
    await c.fetchWindow({ ...base, language: 'de' }, 1, 10);
    await c.fetchWindow({ ...base, safesearch: 2 }, 1, 10);
    await c.fetchWindow({ ...base, timeRange: 'day' }, 1, 10);
    await c.fetchWindow({ ...base, engines: ['duckduckgo'] }, 1, 10);
    await c.fetchWindow({ ...base, categories: ['news'] }, 1, 10);
    assert.equal(c.cacheSize, 6, 'each distinct backend query needs its own result set');
  });

  test('an expired entry is refetched, not served stale forever', async () => {
    const { impl, calls } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, cacheTtlMs: 1, fetchImpl: impl });
    await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    const afterFirst = calls();
    await new Promise((r) => setTimeout(r, 5));
    const second = await c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10);
    assert.equal(second.cached, false);
    assert.ok(calls() > afterFirst);
  });

  test('concurrent cold-cache pages are still disjoint', async () => {
    const { impl } = shufflingBackend(100, 25);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    const windows = await Promise.all(
      [1, 11, 21].map((start) => c.fetchWindow({ query: 'test', safesearch: 0 }, start, 10)),
    );
    const all = windows.flatMap((w) => w.window.map((r) => r.url));
    assert.equal(all.length, 30);
    assert.equal(new Set(all).size, 30, 'concurrent first-touch requests must not race into competing result sets');
    assert.equal(c.cacheSize, 1);
  });

  test('a backend failure does not poison queued requests for the same query', async () => {
    let call = 0;
    const impl: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      call++;
      if (call === 1) throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' });
      return new Response(
        JSON.stringify({
          query: url.searchParams.get('q'),
          results: Array.from({ length: 25 }, (_, i) => ({ url: `https://example.com/r/${i + 1}`, title: `R${i + 1}` })),
          answers: [],
          corrections: [],
          infoboxes: [],
          suggestions: [],
          unresponsive_engines: [],
        }),
        { status: 200 },
      );
    };
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, fetchImpl: impl });
    const [first, second] = await Promise.allSettled([
      c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10),
      c.fetchWindow({ query: 'test', safesearch: 0 }, 1, 10),
    ]);
    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'fulfilled');
    assert.equal((second as PromiseFulfilledResult<{ window: unknown[] }>).value.window.length, 10);
  });

  test('the cache is bounded', async () => {
    const { impl } = shufflingBackend(30, 30);
    const c = new SearxngClient({ baseUrl: 'http://searxng.test', timeoutMs: 5000, cacheMax: 3, fetchImpl: impl });
    for (const q of ['a', 'b', 'c', 'd', 'e']) {
      await c.fetchWindow({ query: q, safesearch: 0 }, 1, 10);
    }
    assert.equal(c.cacheSize, 3);
  });
});
