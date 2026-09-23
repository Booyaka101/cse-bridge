/**
 * A cx's site list: pattern matching, the backend `site:` clause, the
 * post-filter that enforces the list when engines ignore that clause, and the
 * cache identity that keeps two profiles' result sets apart.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchUrl, parseSitePattern, parseYaml, profilesFromYaml, ProfilesError } from '../src/profiles.ts';
import { buildQueryString, siteScope, MAX_SITE_OPERATORS, type CseParams } from '../src/params.ts';
import { SearxngClient, cacheKey, type SearxngResult } from '../src/searxng.ts';
import { createBridge, OFF_LIST_HEADER, SITE_MODE_HEADER } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { cseParams } from './helpers.ts';

const params = (over: Partial<CseParams> = {}): CseParams => cseParams({ q: 'widgets', ...over });

describe('matchUrl', () => {
  const cases: [url: string, sites: string[], exclude: string[], expected: boolean][] = [
    // No list, no restriction.
    ['https://anything.test/x', [], [], true],
    // A bare host covers itself and its subdomains, not lookalikes.
    ['https://example.com/', ['example.com'], [], true],
    ['https://docs.example.com/a/b', ['example.com'], [], true],
    ['https://notexample.com/', ['example.com'], [], false],
    ['https://example.com.evil.test/', ['example.com'], [], false],
    // The PSE form of the same thing.
    ['https://a.b.example.com/', ['*.example.com'], [], true],
    ['https://example.com/', ['*.example.com'], [], true],
    ['https://example.com/deep/page', ['*.example.com/*'], [], true],
    // A scheme in the pattern is ignored; either scheme matches.
    ['http://www.webmd.com/hw/diet', ['https://www.webmd.com/hw/*'], [], true],
    // Case: hosts are case-insensitive, paths are not.
    ['https://WWW.Example.COM/Docs/x', ['www.example.com/Docs/*'], [], true],
    ['https://www.example.com/docs/x', ['www.example.com/Docs/*'], [], false],
    // An IDN pattern matches the punycode host a result carries, and vice versa.
    ['https://xn--bcher-kva.example/', ['bücher.example'], [], true],
    ['https://bücher.example/katalog', ['xn--bcher-kva.example'], [], true],
    // Path prefixes stop at a segment boundary.
    ['https://www.webmd.com/hw', ['www.webmd.com/hw/*'], [], true],
    ['https://www.webmd.com/hw/diet/keto', ['www.webmd.com/hw/*'], [], true],
    ['https://www.webmd.com/hwx/diet', ['www.webmd.com/hw/*'], [], false],
    ['https://m.webmd.com/hw/diet', ['www.webmd.com/hw/*'], [], false],
    // A trailing * without a slash is a plain string prefix.
    ['https://www.webmd.com/hwx/diet', ['www.webmd.com/hw*'], [], true],
    // No trailing star means that one page, trailing slash or not.
    ['https://example.com/about', ['example.com/about'], [], true],
    ['https://example.com/about/', ['example.com/about'], [], true],
    ['https://example.com/about/team', ['example.com/about'], [], false],
    // A star mid-path.
    ['https://example.com/2024/05/post', ['example.com/*/05/*'], [], true],
    ['https://example.com/2024/06/post', ['example.com/*/05/*'], [], false],
    // A pattern with a query matches the query too.
    ['https://www.youtube.com/watch?v=abc', ['www.youtube.com/watch?v=*'], [], true],
    ['https://www.youtube.com/watch?list=abc', ['www.youtube.com/watch?v=*'], [], false],
    // Excludes win over includes, and apply on their own.
    ['https://www.webmd.com/hw/cancer/lung', ['www.webmd.com/hw/*'], ['www.webmd.com/hw/cancer/*'], false],
    ['https://www.webmd.com/hw/diet', ['www.webmd.com/hw/*'], ['www.webmd.com/hw/cancer/*'], true],
    ['https://spam.test/', [], ['spam.test'], false],
    ['https://fine.test/', [], ['spam.test'], true],
    // Unparseable result URLs never pass a restricted list.
    ['not a url', ['example.com'], [], false],
  ];

  for (const [url, sites, exclude, expected] of cases) {
    test(`${url} against [${sites.join(', ')}] minus [${exclude.join(', ')}] is ${expected}`, () => {
      assert.equal(matchUrl(url, sites, exclude), expected);
    });
  }

  test('an unreadable pattern matches nothing rather than everything', () => {
    assert.equal(matchUrl('https://example.com/', ['has space.com'], []), false);
    assert.equal(matchUrl('https://example.com/', [], ['has space.com']), true);
  });
});

describe('parseSitePattern', () => {
  test('canonicalizes the forms a PSE export contains', () => {
    assert.equal(parseSitePattern('https://WWW.WebMD.com/hw/*')?.text, 'www.webmd.com/hw/*');
    assert.equal(parseSitePattern('bücher.example')?.text, 'xn--bcher-kva.example');
    assert.equal(parseSitePattern('*.example.com/*')?.text, '*.example.com/*');
  });

  test('the backend operand is the literal prefix, without stars', () => {
    assert.equal(parseSitePattern('www.webmd.com/hw/*')?.operand, 'www.webmd.com/hw');
    assert.equal(parseSitePattern('*.example.com/*')?.operand, 'example.com');
    assert.equal(parseSitePattern('example.com')?.operand, 'example.com');
  });

  test('rejects what is not a host pattern', () => {
    for (const bad of ['', 'has space.com', 'user@example.com', 'ex*ample.com', '"quoted".com', 'https://']) {
      assert.equal(parseSitePattern(bad), undefined, bad);
    }
  });
});

describe('profile site lists', () => {
  test('sites and exclude accept a list or a single string, and site: stays sugar', () => {
    const set = profilesFromYaml(
      `
listed:
  sites:
    - example.com
    - "https://WWW.Other.test/docs/*"
  exclude: example.com/private/*
flow:
  sites: [a.test, b.test]
single:
  sites: one.test
legacy:
  site: docs.rs
both:
  site: docs.rs
  sites: [crates.io, docs.rs]
`,
      'test.yml',
    );
    assert.deepEqual(set.get('listed').sites, ['example.com', 'www.other.test/docs/*']);
    assert.deepEqual(set.get('listed').exclude, ['example.com/private/*']);
    assert.deepEqual(set.get('flow').sites, ['a.test', 'b.test']);
    assert.deepEqual(set.get('single').sites, ['one.test']);
    assert.deepEqual(set.get('legacy').sites, ['docs.rs']);
    assert.equal(set.get('legacy').site, 'docs.rs');
    assert.deepEqual(set.get('both').sites, ['docs.rs', 'crates.io']);
    assert.deepEqual(set.get('default').sites, []);
    assert.deepEqual(set.get('default').exclude, []);
  });

  test('a pattern the bridge cannot enforce is a startup error, not a silent wide-open cx', () => {
    assert.throws(() => profilesFromYaml('bad:\n  sites: [has space.com]\n', 't.yml'), ProfilesError);
    assert.throws(() => profilesFromYaml('bad:\n  exclude: [user@example.com]\n', 't.yml'), ProfilesError);
  });

  test('an old-style cx with colons works as a key', () => {
    const doc = parseYaml('012345678901234567890:abcdefghij:\n  site: example.com\n');
    assert.deepEqual(doc['012345678901234567890:abcdefghij'], { site: 'example.com' });
    const set = profilesFromYaml('"012345:abc":\n  sites: [example.com]\n', 't.yml');
    assert.deepEqual(set.get('012345:abc').sites, ['example.com']);
  });
});

describe('buildQueryString with a site list', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}.test`);

  test('0 sites adds nothing', () => {
    assert.equal(buildQueryString(params(), []), 'widgets');
  });

  test('1 site is a bare site: term, as in 1.2', () => {
    assert.equal(buildQueryString(params(), ['s1.test']), 'widgets site:s1.test');
  });

  test(`${MAX_SITE_OPERATORS} sites become one OR group`, () => {
    assert.equal(MAX_SITE_OPERATORS, 8);
    assert.equal(
      buildQueryString(params(), list(8)),
      `widgets (${list(8)
        .map((s) => `site:${s}`)
        .join(' OR ')})`,
    );
  });

  test(`${MAX_SITE_OPERATORS + 1} sites send no site: at all and are filter-only`, () => {
    assert.equal(buildQueryString(params(), list(9)), 'widgets');
    assert.equal(siteScope(params(), list(9)).filterOnly, true);
    assert.equal(siteScope(params(), list(8)).filterOnly, false);
  });

  test('path patterns reach the backend as their literal prefix', () => {
    assert.equal(
      buildQueryString(params(), ['www.webmd.com/hw/*', '*.example.com']),
      'widgets (site:www.webmd.com/hw OR site:example.com)',
    );
  });
});

describe('siteSearch combined with a profile', () => {
  const profile = ['a.test', 'b.test'];

  test('an include is the only backend term, and results must still pass the profile', () => {
    const scope = siteScope(params({ siteSearch: 'a.test' }), profile);
    assert.deepEqual(scope.operators, ['site:a.test']);
    assert.deepEqual(scope.sites, profile);
    assert.deepEqual(scope.narrow, ['a.test']);
  });

  test('an exclude keeps the profile includes and adds -site:', () => {
    const scope = siteScope(params({ siteSearch: 'b.test', siteSearchFilter: 'e' }), profile, ['a.test/private/*']);
    assert.deepEqual(scope.operators, ['(site:a.test OR site:b.test)', '-site:b.test']);
    assert.deepEqual(scope.sites, profile);
    assert.deepEqual(scope.exclude, ['a.test/private/*', 'b.test']);
    assert.equal(
      buildQueryString(params({ siteSearch: 'b.test', siteSearchFilter: 'e' }), profile),
      'widgets (site:a.test OR site:b.test) -site:b.test',
    );
  });

  test('siteSearch still narrows a filter-only profile', () => {
    const many = Array.from({ length: 12 }, (_, i) => `s${i}.test`);
    const scope = siteScope(params({ siteSearch: 's3.test' }), many);
    assert.deepEqual(scope.operators, ['site:s3.test']);
    assert.equal(scope.filterOnly, false, 'the backend does get a site: term here');
  });
});

describe('cacheKey', () => {
  const base = { query: 'diet', safesearch: 0 } as const;

  test('two profiles with the same query string never share a result set', () => {
    assert.notEqual(cacheKey({ ...base, sites: ['a.test'] }), cacheKey({ ...base, sites: ['b.test'] }));
    assert.notEqual(cacheKey({ ...base, sites: ['a.test'] }), cacheKey({ ...base, sites: ['a.test'], exclude: ['a.test/x/*'] }));
    assert.notEqual(cacheKey({ ...base, narrow: ['a.test'] }), cacheKey(base));
  });

  test('list order does not matter', () => {
    assert.equal(cacheKey({ ...base, sites: ['a.test', 'b.test'] }), cacheKey({ ...base, sites: ['b.test', 'a.test'] }));
  });
});

/** A backend that ignores site: entirely, the way SearXNG's bing engine was measured to. */
function leakyBackend(pages: string[][], calls: URL[] = []): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const pageno = Number(url.searchParams.get('pageno') ?? '1');
    const results: SearxngResult[] = (pages[pageno - 1] ?? []).map((link, i) => ({
      url: link,
      title: `Result ${pageno}.${i}`,
      content: 'snippet',
      engine: 'leaky',
    }));
    return new Response(JSON.stringify({ query: url.searchParams.get('q'), results }), { status: 200 });
  };
}

describe('fetchWindow post-filter', () => {
  test('off-list results never reach the window, whatever the backend sends', async () => {
    const c = new SearxngClient({
      baseUrl: 'http://searxng.test',
      timeoutMs: 5000,
      fetchImpl: leakyBackend([
        ['https://www.webmd.com/hw/diet', 'https://spam.test/1', 'https://www.webmd.com/hw/cancer/a'],
        ['https://www.bing.com/x', 'https://www.webmd.com/hw/sleep'],
      ]),
    });
    const { window, hasMore } = await c.fetchWindow(
      { query: 'diet', safesearch: 0, sites: ['www.webmd.com/hw/*'], exclude: ['www.webmd.com/hw/cancer/*'] },
      1,
      10,
    );
    assert.deepEqual(
      window.map((r) => r.url),
      ['https://www.webmd.com/hw/diet', 'https://www.webmd.com/hw/sleep'],
    );
    assert.equal(hasMore, false);
  });

  test('a page of nothing but off-list results does not stop the walk', async () => {
    const calls: URL[] = [];
    const c = new SearxngClient({
      baseUrl: 'http://searxng.test',
      timeoutMs: 5000,
      fetchImpl: leakyBackend(
        [['https://off.test/1', 'https://off.test/2'], ['https://on.test/1'], []],
        calls,
      ),
    });
    const { window } = await c.fetchWindow({ query: 'q', safesearch: 0, sites: ['on.test'] }, 1, 10);
    assert.deepEqual(window.map((r) => r.url), ['https://on.test/1']);
    assert.equal(calls.length, 3, 'walks past the all-dropped first page and stops at the empty third');
  });

  test('a page repeating only already-dropped results counts as run dry', async () => {
    const calls: URL[] = [];
    const repeat = ['https://off.test/1', 'https://on.test/1'];
    const c = new SearxngClient({
      baseUrl: 'http://searxng.test',
      timeoutMs: 5000,
      fetchImpl: leakyBackend([repeat, repeat, repeat, repeat], calls),
    });
    await c.fetchWindow({ query: 'q', safesearch: 0, sites: ['on.test'] }, 1, 10);
    assert.equal(calls.length, 2);
  });

  test('siteSearch narrows inside the profile, never outside it', async () => {
    const c = new SearxngClient({
      baseUrl: 'http://searxng.test',
      timeoutMs: 5000,
      fetchImpl: leakyBackend([['https://a.test/1', 'https://b.test/1', 'https://outside.test/1']]),
    });
    const inside = await c.fetchWindow({ query: 'q', safesearch: 0, sites: ['a.test', 'b.test'], narrow: ['b.test'] }, 1, 10);
    assert.deepEqual(inside.window.map((r) => r.url), ['https://b.test/1']);
    const outside = await c.fetchWindow(
      { query: 'q', safesearch: 0, sites: ['a.test', 'b.test'], narrow: ['outside.test'] },
      1,
      10,
    );
    assert.deepEqual(outside.window, []);
  });
});

describe('site lists over HTTP', () => {
  const webmd = [
    'https://www.webmd.com/hw/diet/keto',
    'https://www.webmd.com/hw/cancer/diet-and-cancer',
    'https://www.healthline.com/nutrition/diet',
    'https://www.webmd.com/hw/diet/mediterranean',
    'https://www.webmd.com/diet/news',
    'https://www.webmd.com/hw/cancer/nutrition',
    'https://www.webmd.com/hw/weight/plans',
  ];

  async function start(pages: string[][], profilesYaml: string, calls: URL[] = []) {
    const config = loadConfig({ PORT: '0', SEARXNG_URL: 'http://searxng.test' });
    const bridge = createBridge({
      config,
      log: false,
      profiles: profilesFromYaml(profilesYaml, 'test.yml'),
      client: new SearxngClient({ baseUrl: config.searxngUrl, timeoutMs: 5000, fetchImpl: leakyBackend(pages, calls) }),
    });
    const { port } = await bridge.listen();
    return { bridge, base: `http://127.0.0.1:${port}` };
  }

  test('q=diet&cx=webmd returns hw pages and never hw/cancer pages', async () => {
    const calls: URL[] = [];
    const { bridge, base } = await start(
      [webmd],
      'webmd:\n  sites:\n    - "www.webmd.com/hw/*"\n  exclude:\n    - "www.webmd.com/hw/cancer/*"\n',
      calls,
    );
    try {
      const res = await fetch(`${base}/customsearch/v1?cx=webmd&q=diet`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get(SITE_MODE_HEADER), null);
      const body = await res.json();
      assert.deepEqual(
        body.items.map((i: { link: string }) => i.link),
        [
          'https://www.webmd.com/hw/diet/keto',
          'https://www.webmd.com/hw/diet/mediterranean',
          'https://www.webmd.com/hw/weight/plans',
        ],
      );
      assert.equal(body.searchInformation.totalResults, '3');
      assert.equal(calls[0]!.searchParams.get('q'), 'diet site:www.webmd.com/hw');
      assert.equal(res.headers.get(OFF_LIST_HEADER), '4', 'healthline, /diet/news and both hw/cancer pages');

      const unrestricted = await fetch(`${base}/customsearch/v1?cx=other&q=diet`);
      assert.equal(unrestricted.headers.get(OFF_LIST_HEADER), null);
    } finally {
      await bridge.close();
    }
  });

  test('siteSearch=x&siteSearchFilter=e cannot escape the cx', async () => {
    const calls: URL[] = [];
    const { bridge, base } = await start(
      [['https://a.test/1', 'https://b.test/1', 'https://elsewhere.test/1']],
      'two:\n  sites: [a.test, b.test]\n',
      calls,
    );
    try {
      const body = await (await fetch(`${base}/customsearch/v1?cx=two&q=x&siteSearch=b.test&siteSearchFilter=e`)).json();
      assert.deepEqual(body.items.map((i: { link: string }) => i.link), ['https://a.test/1']);
      assert.equal(calls[0]!.searchParams.get('q'), 'x (site:a.test OR site:b.test) -site:b.test');
    } finally {
      await bridge.close();
    }
  });

  test('a list past the cap is filter-only and says so in a header', async () => {
    const sites = Array.from({ length: 9 }, (_, i) => `s${i}.test`);
    const calls: URL[] = [];
    const { bridge, base } = await start(
      [['https://s4.test/a', 'https://off.test/a', 'https://s8.test/b']],
      `big:\n  sites: [${sites.join(', ')}]\n`,
      calls,
    );
    try {
      const res = await fetch(`${base}/customsearch/v1?cx=big&q=x`);
      assert.equal(res.headers.get(SITE_MODE_HEADER), 'filter-only');
      assert.equal(res.headers.get(OFF_LIST_HEADER), '1');
      const body = await res.json();
      assert.deepEqual(body.items.map((i: { link: string }) => i.link), ['https://s4.test/a', 'https://s8.test/b']);
      assert.equal(calls[0]!.searchParams.get('q'), 'x');
    } finally {
      await bridge.close();
    }
  });

  test('a page emptied by the filter is an honest empty page with a way back', async () => {
    const onList = Array.from({ length: 12 }, (_, i) => `https://on.test/${i}`);
    const offList = Array.from({ length: 30 }, (_, i) => `https://off.test/${i}`);
    const { bridge, base } = await start([[...onList, ...offList], []], 'only:\n  sites: [on.test]\n');
    try {
      const second = await (await fetch(`${base}/customsearch/v1?cx=only&q=x&start=11`)).json();
      assert.equal(second.items.length, 2);
      assert.equal(second.searchInformation.totalResults, '12');
      assert.equal(second.queries.nextPage, undefined);
      assert.equal(second.queries.previousPage[0].startIndex, 1);

      const third = await (await fetch(`${base}/customsearch/v1?cx=only&q=x&start=21`)).json();
      assert.equal(third.items, undefined);
      assert.equal(third.searchInformation.totalResults, '0');
      assert.equal(third.queries.nextPage, undefined);
      assert.equal(third.queries.previousPage[0].startIndex, 11);
    } finally {
      await bridge.close();
    }
  });
});
