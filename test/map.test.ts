import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  URL_TEMPLATE,
  applySort,
  escapeHtml,
  formatNumber,
  formatSearchTime,
  mapItem,
  mapResponse,
  synthesizeTotal,
  toDisplayLink,
} from '../src/map.ts';
import type { CseParams } from '../src/params.ts';
import type { SearxngResult } from '../src/searxng.ts';

const params = (over: Partial<CseParams> = {}): CseParams => ({
  key: 'k',
  cx: 'default',
  q: 'rust async runtime',
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

const result = (n: number, over: Partial<SearxngResult> = {}): SearxngResult => ({
  url: `https://example.com/page/${n}`,
  title: `Result ${n}`,
  content: `Snippet for result ${n}.`,
  engine: 'duckduckgo',
  ...over,
});

const results = (n: number): SearxngResult[] => Array.from({ length: n }, (_, i) => result(i + 1));

describe('response envelope', () => {
  test('kind, url and template match the Google resource exactly', () => {
    const body = mapResponse({ params: params(), results: results(3), hasMore: false, searchTime: 0.21 });
    assert.equal(body.kind, 'customsearch#search');
    assert.equal(body.url.type, 'application/json');
    assert.equal(body.url.template, URL_TEMPLATE);
    assert.equal(
      body.url.template,
      'https://www.googleapis.com/customsearch/v1?q={searchTerms}&num={count?}&start={startIndex?}&cx={cx?}',
    );
  });

  test('queries.request carries the echoed query metadata', () => {
    const body = mapResponse({ params: params({ num: 3 }), results: results(3), hasMore: false, searchTime: 0.21 });
    const req = body.queries.request[0]!;
    assert.equal(req.title, 'Google Custom Search - rust async runtime');
    assert.equal(req.searchTerms, 'rust async runtime');
    assert.equal(req.count, 3);
    assert.equal(req.startIndex, 1);
    assert.equal(req.inputEncoding, 'utf8');
    assert.equal(req.outputEncoding, 'utf8');
    assert.equal(req.safe, 'off');
    assert.equal(req.cx, 'default');
  });

  test('searchInformation is fully populated and self-consistent', () => {
    const body = mapResponse({ params: params(), results: results(4), hasMore: false, searchTime: 0.4567 });
    assert.equal(body.searchInformation.searchTime, 0.4567);
    assert.equal(body.searchInformation.formattedSearchTime, '0.46');
    assert.equal(body.searchInformation.totalResults, '4');
    assert.equal(body.searchInformation.formattedTotalResults, '4');
    assert.equal(body.searchInformation.totalResults, body.queries.request[0]!.totalResults);
  });

  test('formatters match Google\'s presentation', () => {
    assert.equal(formatNumber(1234567), '1,234,567');
    assert.equal(formatNumber(0), '0');
    assert.equal(formatSearchTime(0.1), '0.10');
    assert.equal(formatSearchTime(1.006), '1.01');
    assert.equal(formatSearchTime(0), '0.00');
  });
});

describe('items', () => {
  test('every one of the eight item fields is present and non-empty', () => {
    const body = mapResponse({ params: params({ num: 3 }), results: results(3), hasMore: false, searchTime: 0.1 });
    assert.equal(body.items?.length, 3);
    for (const item of body.items!) {
      assert.equal(item.kind, 'customsearch#result');
      for (const field of [
        'title',
        'htmlTitle',
        'link',
        'displayLink',
        'snippet',
        'htmlSnippet',
        'formattedUrl',
        'htmlFormattedUrl',
      ] as const) {
        assert.ok(
          typeof item[field] === 'string' && item[field].length > 0,
          `item.${field} must be a non-empty string, got ${JSON.stringify(item[field])}`,
        );
      }
    }
  });

  test('displayLink is a bare hostname: no scheme, no path, no query', () => {
    const item = mapItem(result(1, { url: 'https://docs.rs/tokio/latest/tokio/?search=spawn#top' }))!;
    assert.equal(item.displayLink, 'docs.rs');
    assert.ok(!item.displayLink.includes('://'));
    assert.ok(!item.displayLink.includes('/'));
    assert.ok(!item.displayLink.includes('?'));
  });

  test('displayLink survives ports and IDN hosts', () => {
    assert.equal(toDisplayLink('http://localhost:8888/search'), 'localhost');
    assert.equal(toDisplayLink('https://a.b.example.co.uk/x/y'), 'a.b.example.co.uk');
  });

  test('a result with no usable url is dropped rather than emitted broken', () => {
    assert.equal(mapItem({ url: '' }), null);
    assert.equal(mapItem({ url: '   ' }), null);
    const body = mapResponse({
      params: params(),
      results: [result(1), { url: '' } as SearxngResult, result(2)],
      hasMore: false,
      searchTime: 0.1,
    });
    assert.equal(body.items?.length, 2);
    assert.equal(body.queries.request[0]!.count, 2);
  });

  test('a result with no title or content still yields non-empty fields', () => {
    const item = mapItem({ url: 'https://example.org/a' })!;
    assert.equal(item.title, 'example.org');
    assert.ok(item.snippet.length > 0);
    assert.ok(item.htmlTitle.length > 0);
    assert.ok(item.htmlSnippet.length > 0);
  });
});

describe('HTML escaping (tp-custom-search-api copies these through raw)', () => {
  test('escapeHtml covers the five significant characters', () => {
    assert.equal(escapeHtml('<b>a & b</b> "q" \'p\''), '&lt;b&gt;a &amp; b&lt;/b&gt; &quot;q&quot; &#39;p&#39;');
  });

  test('htmlTitle and htmlSnippet are escaped, title and snippet are not', () => {
    const raw = '<script>alert("xss")</script> Tokio & async';
    const item = mapItem(result(1, { title: raw, content: raw }))!;
    assert.equal(item.title, raw);
    assert.equal(item.snippet, raw);
    assert.ok(!item.htmlTitle.includes('<script>'));
    assert.ok(!item.htmlSnippet.includes('<script>'));
    assert.ok(item.htmlTitle.includes('&lt;script&gt;'));
    assert.ok(item.htmlTitle.includes('&amp;'));
    assert.equal(item.htmlTitle, escapeHtml(raw));
    assert.equal(item.htmlSnippet, escapeHtml(raw));
  });

  test('htmlFormattedUrl is escaped too', () => {
    const item = mapItem(result(1, { url: 'https://example.com/a?x=1&y=2' }))!;
    assert.equal(item.formattedUrl, 'https://example.com/a?x=1&y=2');
    assert.equal(item.htmlFormattedUrl, 'https://example.com/a?x=1&amp;y=2');
  });

  test('escaping is not double-applied', () => {
    const item = mapItem(result(1, { title: 'a &amp; b' }))!;
    assert.equal(item.htmlTitle, 'a &amp;amp; b');
    assert.equal(item.title, 'a &amp; b');
  });
});

describe('totalResults synthesis (SearXNG has no count field at all)', () => {
  test('never 0 while items exist', () => {
    for (const start of [1, 11, 91]) {
      for (const n of [1, 5, 10]) {
        const body = mapResponse({
          params: params({ start, num: n }),
          results: results(n),
          hasMore: false,
          searchTime: 0.1,
        });
        assert.notEqual(body.searchInformation.totalResults, '0');
        assert.ok(Number(body.searchInformation.totalResults) >= n);
      }
    }
  });

  test('is a lower bound: at least start-1+items.length', () => {
    const body = mapResponse({ params: params({ start: 21, num: 10 }), results: results(10), hasMore: false, searchTime: 0.1 });
    assert.ok(Number(body.searchInformation.totalResults) >= 20 + 10);
  });

  test('exceeds the current window when a next page exists, so paging loops advance', () => {
    const body = mapResponse({ params: params({ start: 1, num: 10 }), results: results(10), hasMore: true, searchTime: 0.1 });
    const total = Number(body.searchInformation.totalResults);
    assert.ok(total > 10, `expected total > 10 to keep 'while start < total' loops going, got ${total}`);
    assert.equal(total, 20);
  });

  test('is NOT results.length * 100 — the fabricated number the prior art emits', () => {
    const body = mapResponse({ params: params(), results: results(10), hasMore: false, searchTime: 0.1 });
    assert.notEqual(body.searchInformation.totalResults, '1000');
    assert.equal(body.searchInformation.totalResults, '10');
    assert.equal(synthesizeTotal(1, 10, false, 10), 10);
    assert.notEqual(synthesizeTotal(1, 10, false, 10), 10 * 100);
  });

  test('grows monotonically as a client pages forward', () => {
    const totals = [1, 11, 21].map((start) =>
      Number(
        mapResponse({ params: params({ start, num: 10 }), results: results(10), hasMore: true, searchTime: 0.1 })
          .searchInformation.totalResults,
      ),
    );
    assert.deepEqual(totals, [20, 30, 40]);
    assert.ok(totals[0]! < totals[1]! && totals[1]! < totals[2]!);
  });
});

describe('zero results', () => {
  const empty = mapResponse({ params: params(), results: [], hasMore: false, searchTime: 0.08 });

  test('omits items entirely rather than sending []', () => {
    assert.equal('items' in empty, false, 'Google omits the key; `if "items" in resp` must be false');
    assert.equal(empty.items, undefined);
    assert.equal(JSON.stringify(empty).includes('"items"'), false);
  });

  test('still emits searchInformation with totalResults "0"', () => {
    assert.equal(empty.searchInformation.totalResults, '0');
    assert.equal(empty.searchInformation.formattedTotalResults, '0');
    assert.ok(typeof empty.searchInformation.searchTime === 'number');
    assert.equal(empty.searchInformation.formattedSearchTime, '0.08');
  });

  test('still emits queries.request with count 0 and no nextPage', () => {
    assert.equal(empty.queries.request[0]!.count, 0);
    assert.equal(empty.queries.nextPage, undefined);
  });
});

describe('spelling corrections', () => {
  test('SearXNG corrections surface as Google\'s spelling block', () => {
    const body = mapResponse({
      params: params(),
      results: results(1),
      hasMore: false,
      searchTime: 0.1,
      corrections: ['rust async runtime'],
    });
    assert.equal(body.spelling?.correctedQuery, 'rust async runtime');
    assert.equal(body.spelling?.htmlCorrectedQuery, 'rust async runtime');
  });

  test('no corrections means no spelling key', () => {
    const body = mapResponse({ params: params(), results: results(1), hasMore: false, searchTime: 0.1, corrections: [] });
    assert.equal('spelling' in body, false);
  });
});

describe('applySort', () => {
  test('leaves order alone without sort=date', () => {
    const input = results(3);
    assert.deepEqual(applySort(input, undefined), input);
    assert.deepEqual(applySort(input, 'relevance'), input);
  });

  test('sort=date orders newest first and keeps undated results last', () => {
    const input: SearxngResult[] = [
      result(1, { publishedDate: '2024-01-01T00:00:00Z' }),
      result(2, {}),
      result(3, { publishedDate: '2026-01-01T00:00:00Z' }),
    ];
    const sorted = applySort(input, 'date');
    assert.deepEqual(sorted.map((r) => r.url), [
      'https://example.com/page/3',
      'https://example.com/page/1',
      'https://example.com/page/2',
    ]);
  });

  test('sort=date:a orders oldest first', () => {
    const input: SearxngResult[] = [
      result(1, { publishedDate: '2026-01-01T00:00:00Z' }),
      result(2, { publishedDate: '2024-01-01T00:00:00Z' }),
    ];
    assert.deepEqual(applySort(input, 'date:a').map((r) => r.url), [
      'https://example.com/page/2',
      'https://example.com/page/1',
    ]);
  });
});
