/**
 * Pagemap reconstruction: the parser, the fetch guardrails, and the feature
 * flag as seen through a real HTTP request.
 *
 * The fixture pages below are the whole point of the suite — each one is a
 * shape a real result page takes, and each asserts exactly what we are willing
 * to claim about it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PagemapClient,
  isPrivateHost,
  headOf,
  parsePagemap,
  type PageMap,
} from '../src/pagemap.ts';
import { createBridge, handleSearch, type Bridge } from '../src/server.ts';
import { loadConfig, ConfigError } from '../src/config.ts';
import { SearxngClient, type SearxngResult } from '../src/searxng.ts';
import { profilesFromYaml, builtinProfiles, ProfilesError } from '../src/profiles.ts';

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

const PAGE_OG = `<!doctype html>
<html><head>
<title>Widget Docs</title>
<meta property="og:title" content="Widget Docs">
<meta property="og:image" content="https://ex.com/w.png">
<meta name="description" content="How widgets work">
</head><body><p>hi</p></body></html>`;

const PAGE_JSONLD = `<!doctype html>
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "NewsArticle",
  "headline": "Widgets shipped",
  "datePublished": "2026-08-01",
  "author": { "@type": "Person", "name": "Ada Lovelace" },
  "image": ["https://ex.com/news.png"]
}
</script>
</head><body></body></html>`;

const PAGE_MICRODATA = `<!doctype html>
<html itemscope itemtype="https://schema.org/WebPage"><head>
<meta itemprop="name" content="Widget Handbook">
<meta itemprop="datePublished" content="2026-02-03">
<link itemprop="url" href="https://ex.com/handbook">
</head><body></body></html>`;

const PAGE_LITERAL = `<!doctype html>
<html><head>
<meta name="description" content="derived description">
<!--
<PageMap>
  <DataObject type="document">
    <Attribute name="title" value="Authoritative Title"/>
    <Attribute name="author">Grace Hopper</Attribute>
  </DataObject>
  <DataObject type="thumbnail">
    <Attribute name="src" value="https://ex.com/t.png"/>
  </DataObject>
</PageMap>
-->
</head><body></body></html>`;

const PAGE_BARE = `<!doctype html>
<html><head><title>Nothing to see</title></head><body><p>plain</p></body></html>`;

const HTML = { 'content-type': 'text/html; charset=utf-8' };

/** A fetch that serves the fixture map and counts every call. */
function fakePages(pages: Record<string, string>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const body = pages[url];
    if (body === undefined) return new Response('not found', { status: 404, headers: HTML });
    return new Response(body, { status: 200, headers: HTML });
  };
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

function client(over: Partial<ConstructorParameters<typeof PagemapClient>[0]> = {}): PagemapClient {
  return new PagemapClient({
    maxUrls: 10,
    timeoutMs: 500,
    budgetMs: 2000,
    ttlMs: 60_000,
    cacheMax: 16,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe('parsePagemap — the worked example', () => {
  test('og:title + og:image + description produce metatags, cse_image and cse_thumbnail', () => {
    const map = parsePagemap(PAGE_OG, 'https://ex.com/widgets');
    assert.deepEqual(map, {
      metatags: [
        {
          'og:title': 'Widget Docs',
          'og:image': 'https://ex.com/w.png',
          description: 'How widgets work',
        },
      ],
      cse_image: [{ src: 'https://ex.com/w.png' }],
      cse_thumbnail: [{ src: 'https://ex.com/w.png' }],
    });
  });

  test('cse_thumbnail carries src and nothing else — Google\'s crop dimensions are unknowable', () => {
    const map = parsePagemap(PAGE_OG, 'https://ex.com/widgets')!;
    assert.deepEqual(Object.keys(map['cse_thumbnail']![0]!), ['src']);
  });
});

describe('parsePagemap — each source in isolation', () => {
  test('JSON-LD becomes DataObjects named by lowercased schema.org type', () => {
    const map = parsePagemap(PAGE_JSONLD, 'https://ex.com/news')!;
    assert.deepEqual(map['newsarticle'], [
      { headline: 'Widgets shipped', datepublished: '2026-08-01', image: 'https://ex.com/news.png' },
    ]);
    assert.deepEqual(map['person'], [{ name: 'Ada Lovelace' }]);
    assert.equal(map['metatags'], undefined);
  });

  test('microdata itemtype/itemprop become a DataObject', () => {
    const map = parsePagemap(PAGE_MICRODATA, 'https://ex.com/handbook')!;
    assert.deepEqual(map['webpage'], [
      { name: 'Widget Handbook', datepublished: '2026-02-03', url: 'https://ex.com/handbook' },
    ]);
  });

  test('a literal <PageMap> block is read through its HTML comment', () => {
    const map = parsePagemap(PAGE_LITERAL, 'https://ex.com/doc')!;
    assert.deepEqual(map['document'], [{ title: 'Authoritative Title', author: 'Grace Hopper' }]);
    assert.deepEqual(map['thumbnail'], [{ src: 'https://ex.com/t.png' }]);
    // The derived metatags still come through alongside it.
    assert.deepEqual(map['metatags'], [{ description: 'derived description' }]);
  });

  test('a page with no metadata produces NO pagemap key at all, not an empty object', () => {
    assert.equal(parsePagemap(PAGE_BARE, 'https://ex.com/bare'), undefined);
  });
});

describe('parsePagemap — details a naive scanner gets wrong', () => {
  test('property keeps its case, a bare name is lowercased', () => {
    const html = '<head><meta property="og:Site_Name" content="Ex"><meta name="Twitter:Card" content="summary"></head>';
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.deepEqual(map['metatags'], [{ 'og:Site_Name': 'Ex', 'twitter:card': 'summary' }]);
  });

  test('entities in content are decoded', () => {
    const html = '<head><meta name="description" content="Tom &amp; Jerry &#39;s &quot;show&quot;"></head>';
    assert.equal(parsePagemap(html, 'https://ex.com/')!['metatags']![0]!['description'], 'Tom & Jerry \'s "show"');
  });

  test('the first occurrence of a repeated key wins', () => {
    const html = '<head><meta property="og:image" content="https://ex.com/a.png"><meta property="og:image" content="https://ex.com/b.png"></head>';
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.equal(map['cse_image']![0]!['src'], 'https://ex.com/a.png');
  });

  test('a relative og:image is resolved against the page URL', () => {
    const html = '<head><meta property="og:image" content="/img/hero.png"></head>';
    const map = parsePagemap(html, 'https://ex.com/docs/page')!;
    assert.equal(map['cse_image']![0]!['src'], 'https://ex.com/img/hero.png');
  });

  test('twitter:image is the fallback when there is no og:image', () => {
    const html = '<head><meta name="twitter:image" content="https://ex.com/t.png"></head>';
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.equal(map['cse_thumbnail']![0]!['src'], 'https://ex.com/t.png');
  });

  test('the image falls back through secure_url and twitter:image:src', () => {
    const secure = '<head><meta property="og:image:secure_url" content="https://ex.com/s.png"></head>';
    assert.deepEqual(parsePagemap(secure, 'https://ex.com/')!['cse_image'], [{ src: 'https://ex.com/s.png' }]);

    const twitter = '<head><meta name="twitter:image:src" content="/t.png"></head>';
    assert.deepEqual(parsePagemap(twitter, 'https://ex.com/p/')!['cse_image'], [{ src: 'https://ex.com/t.png' }]);

    const both = `<head><meta property="og:image" content="https://ex.com/og.png">
      <meta name="twitter:image:src" content="https://ex.com/tw.png"></head>`;
    assert.deepEqual(parsePagemap(both, 'https://ex.com/')!['cse_image'], [{ src: 'https://ex.com/og.png' }]);
  });

  test('a javascript: image URL is refused, and the page still yields its metatags', () => {
    const html = '<head><meta property="og:image" content="javascript:alert(1)"></head>';
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.equal(map['cse_image'], undefined);
    assert.equal(map['cse_thumbnail'], undefined);
    assert.ok(map['metatags']);
  });

  test('a value past Google\'s 1024-character property limit is dropped, never truncated', () => {
    const long = 'x'.repeat(1025);
    const html = `<head><meta name="description" content="${long}"><meta name="keywords" content="ok"></head>`;
    assert.deepEqual(parsePagemap(html, 'https://ex.com/')!['metatags'], [{ keywords: 'ok' }]);
  });

  test('a quoted attribute containing > does not end the tag early', () => {
    const html =
      '<head><meta name="description" content="if a > b then swap">' +
      '<div itemscope itemtype="https://schema.org/WebPage"><meta itemprop="name" content="a > b"></div></head>';
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.deepEqual(map['metatags'], [{ description: 'if a > b then swap' }]);
    assert.deepEqual(map['webpage'], [{ name: 'a > b' }]);
  });

  test('commented-out meta tags are not read as real ones', () => {
    const html = '<head><!-- <meta name="description" content="draft"> --><meta name="author" content="real"></head>';
    assert.deepEqual(parsePagemap(html, 'https://ex.com/')!['metatags'], [{ author: 'real' }]);
  });

  test('broken JSON-LD is skipped without losing the rest of the page', () => {
    const html = '<head><script type="application/ld+json">{oops</script><meta name="author" content="real"></head>';
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.deepEqual(map['metatags'], [{ author: 'real' }]);
  });

  test('@graph documents are walked', () => {
    const html = `<head><script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Ex Ltd"},{"@type":"WebSite","name":"Ex"}]}
    </script></head>`;
    const map = parsePagemap(html, 'https://ex.com/')!;
    assert.deepEqual(map['organization'], [{ name: 'Ex Ltd' }]);
    assert.deepEqual(map['website'], [{ name: 'Ex' }]);
  });
});

describe('headOf', () => {
  test('cuts at </head>, so body markup is never scanned', () => {
    const html = '<head><meta name="a" content="1"></head><body><meta name="b" content="2"></body>';
    assert.ok(!headOf(html).includes('name="b"'));
    assert.deepEqual(parsePagemap(html, 'https://ex.com/')!['metatags'], [{ a: '1' }]);
  });

  test('a document with no </head> is scanned whole', () => {
    assert.equal(headOf('<meta name="a" content="1">'), '<meta name="a" content="1">');
  });
});

// ---------------------------------------------------------------------------
// Fetching, caching and the guardrails
// ---------------------------------------------------------------------------

describe('PagemapClient.enrich', () => {
  test('attaches the pagemap to the item it belongs to', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/widgets': PAGE_OG });
    const items = [{ link: 'https://ex.com/widgets' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl }).enrich(items);
    assert.equal(items[0]!.pagemap!['metatags']![0]!['og:title'], 'Widget Docs');
  });

  test('a second identical request is served from the cache with no refetch', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/widgets': PAGE_OG });
    const pagemap = client({ fetchImpl });

    const first = [{ link: 'https://ex.com/widgets' }] as { link: string; pagemap?: PageMap }[];
    await pagemap.enrich(first);
    const second = [{ link: 'https://ex.com/widgets' }] as { link: string; pagemap?: PageMap }[];
    await pagemap.enrich(second);

    assert.equal(fetchImpl.calls.length, 1, 'the page must be fetched exactly once');
    assert.deepEqual(second[0]!.pagemap, first[0]!.pagemap);
    assert.equal(pagemap.cacheSize, 1);
  });

  test('a page that yields nothing is cached too, so a dead weight URL is not refetched', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/bare': PAGE_BARE });
    const pagemap = client({ fetchImpl });
    const items = [{ link: 'https://ex.com/bare' }] as { link: string; pagemap?: PageMap }[];
    await pagemap.enrich(items);
    await pagemap.enrich(items);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal('pagemap' in items[0]!, false);
  });

  test('ttlMs=0 disables the cache entirely', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/widgets': PAGE_OG });
    const pagemap = client({ fetchImpl, ttlMs: 0 });
    await pagemap.enrich([{ link: 'https://ex.com/widgets' }]);
    await pagemap.enrich([{ link: 'https://ex.com/widgets' }]);
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(pagemap.cacheSize, 0);
  });

  test('a URL that times out leaves that item bare and everything else intact', async () => {
    const slow = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://ex.com/slow') {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return new Response(PAGE_OG, { status: 200, headers: HTML });
    };
    const items = [
      { link: 'https://ex.com/slow' },
      { link: 'https://ex.com/widgets' },
    ] as { link: string; pagemap?: PageMap }[];

    await client({ fetchImpl: slow as unknown as typeof fetch, timeoutMs: 60 }).enrich(items);

    assert.equal('pagemap' in items[0]!, false, 'the slow page must not produce a pagemap');
    assert.ok(items[1]!.pagemap, 'the healthy page must still be enriched');
  });

  test('the total budget stops the pass and leaves the rest bare', async () => {
    const pages: Record<string, string> = {};
    const items: { link: string; pagemap?: PageMap }[] = [];
    for (let i = 1; i <= 8; i++) {
      pages[`https://ex.com/p/${i}`] = PAGE_OG;
      items.push({ link: `https://ex.com/p/${i}` });
    }
    const hangAfterFour = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/p\/[1-4]$/.test(url)) return new Response(PAGE_OG, { status: 200, headers: HTML });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    const started = Date.now();
    await client({
      fetchImpl: hangAfterFour as unknown as typeof fetch,
      timeoutMs: 10_000,
      budgetMs: 120,
    }).enrich(items);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 2000, `the budget must cut the pass short, took ${elapsed}ms`);
    assert.ok(items[0]!.pagemap, 'the pages that answered are still enriched');
    assert.equal('pagemap' in items[7]!, false, 'the pages the budget never reached stay bare');
  });

  test('never runs more than four fetches at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const counted = async (): Promise<Response> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(PAGE_OG, { status: 200, headers: HTML });
    };
    const items = Array.from({ length: 10 }, (_v, i) => ({ link: `https://ex.com/c/${i}` }));
    await client({ fetchImpl: counted as unknown as typeof fetch }).enrich(items);
    assert.equal(peak, 4);
  });

  test('fetches at most maxUrls pages', async () => {
    const fetchImpl = fakePages({});
    const items = Array.from({ length: 10 }, (_v, i) => ({ link: `https://ex.com/m/${i}` }));
    await client({ fetchImpl, maxUrls: 3 }).enrich(items);
    assert.equal(fetchImpl.calls.length, 3);
  });

  test('maxUrls=0 fetches nothing at all', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/widgets': PAGE_OG });
    await client({ fetchImpl, maxUrls: 0 }).enrich([{ link: 'https://ex.com/widgets' }]);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('an image result is read from image.contextLink, never from the image file', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/gallery': PAGE_OG });
    const items = [
      { link: 'https://ex.com/photo.jpg', image: { contextLink: 'https://ex.com/gallery' } },
    ] as { link: string; image?: { contextLink: string }; pagemap?: PageMap }[];
    await client({ fetchImpl }).enrich(items);
    assert.deepEqual(fetchImpl.calls, ['https://ex.com/gallery']);
    assert.ok(items[0]!.pagemap);
  });

  test('results sharing a page cost one fetch and all get the pagemap', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/gallery': PAGE_OG });
    const items = [
      { link: 'https://ex.com/1.jpg', image: { contextLink: 'https://ex.com/gallery' } },
      { link: 'https://ex.com/2.jpg', image: { contextLink: 'https://ex.com/gallery' } },
      { link: 'https://ex.com/3.jpg', image: { contextLink: 'https://ex.com/gallery' } },
    ] as { link: string; image?: { contextLink: string }; pagemap?: PageMap }[];
    await client({ fetchImpl }).enrich(items);
    assert.deepEqual(fetchImpl.calls, ['https://ex.com/gallery']);
    assert.ok(items.every((i) => i.pagemap !== undefined));
  });

  test('the fragment is dropped, so #section links share one fetch', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/widgets': PAGE_OG });
    const items = [
      { link: 'https://ex.com/widgets#install' },
      { link: 'https://ex.com/widgets#usage' },
    ] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl }).enrich(items);
    assert.deepEqual(fetchImpl.calls, ['https://ex.com/widgets']);
    assert.ok(items[1]!.pagemap);
  });

  test('maxUrls caps pages, not items', async () => {
    const fetchImpl = fakePages({ 'https://ex.com/a': PAGE_OG, 'https://ex.com/b': PAGE_OG });
    const items = [
      { link: 'https://ex.com/a' },
      { link: 'https://ex.com/a#two' },
      { link: 'https://ex.com/b' },
      { link: 'https://ex.com/c' },
    ] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl, maxUrls: 2 }).enrich(items);
    assert.deepEqual(fetchImpl.calls.sort(), ['https://ex.com/a', 'https://ex.com/b']);
    assert.ok(items[1]!.pagemap, 'the second link to the same page is enriched for free');
    assert.equal('pagemap' in items[3]!, false);
  });

  test('a <meta charset> is honoured when the header declares none', async () => {
    // "Café décor" in windows-1252: the 0xe9 bytes are invalid utf-8.
    const bytes = Uint8Array.from([
      ...Buffer.from('<head><meta charset="windows-1252"><meta name="description" content="Caf'),
      0xe9,
      ...Buffer.from(' d'),
      0xe9,
      ...Buffer.from('cor"></head>'),
    ]);
    const impl = async (): Promise<Response> =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } });
    const items = [{ link: 'https://ex.com/cafe' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl: impl as unknown as typeof fetch }).enrich(items);
    assert.equal(items[0]!.pagemap!['metatags']![0]!['description'], 'Café décor');
  });

  test('a non-HTML response is dropped without being parsed', async () => {
    const pdf = async (): Promise<Response> =>
      new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } });
    const items = [{ link: 'https://ex.com/spec.pdf' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl: pdf as unknown as typeof fetch }).enrich(items);
    assert.equal('pagemap' in items[0]!, false);
  });

  test('a 404 leaves the item bare', async () => {
    const fetchImpl = fakePages({});
    const items = [{ link: 'https://ex.com/gone' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl }).enrich(items);
    assert.equal('pagemap' in items[0]!, false);
  });

  test('follows two redirects and refuses a third', async () => {
    const chain: Record<string, string> = {
      'https://ex.com/r0': 'https://ex.com/r1',
      'https://ex.com/r1': 'https://ex.com/r2',
      'https://ex.com/r2': 'https://ex.com/r3',
      'https://ex.com/deep0': 'https://ex.com/deep1',
      'https://ex.com/deep1': 'https://ex.com/final',
    };
    const redirecting = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const next = chain[url];
      if (next !== undefined) return new Response(null, { status: 301, headers: { location: next } });
      return new Response(PAGE_OG, { status: 200, headers: HTML });
    };
    const items = [
      { link: 'https://ex.com/deep0' },
      { link: 'https://ex.com/r0' },
    ] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl: redirecting as unknown as typeof fetch }).enrich(items);
    assert.ok(items[0]!.pagemap, 'two hops are allowed');
    assert.equal('pagemap' in items[1]!, false, 'a third hop is refused');
  });

  test('a relative Location header is resolved against the current URL', async () => {
    const relative = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://ex.com/old') return new Response(null, { status: 302, headers: { location: '/new' } });
      assert.equal(url, 'https://ex.com/new');
      return new Response(PAGE_OG, { status: 200, headers: HTML });
    };
    const items = [{ link: 'https://ex.com/old' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl: relative as unknown as typeof fetch }).enrich(items);
    assert.ok(items[0]!.pagemap);
  });

  test('stops reading the body at </head>', async () => {
    const chunks = [
      '<head><meta name="a" content="1"></head>',
      ...Array.from({ length: 8 }, () => '<p>x</p>'.repeat(10_000)),
    ];
    let pulled = 0;
    let cancelled = false;
    const streaming = async (): Promise<Response> => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          pull(controller) {
            const chunk = chunks[pulled++];
            if (chunk === undefined) controller.close();
            else controller.enqueue(encoder.encode(chunk));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: HTML },
      );
    };
    const items = [{ link: 'https://ex.com/huge' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl: streaming as unknown as typeof fetch }).enrich(items);
    assert.deepEqual(items[0]!.pagemap!['metatags'], [{ a: '1' }]);
    assert.ok(cancelled, 'the download must be cancelled, not drained');
    assert.ok(pulled < chunks.length, `the body must not be read to the end, pulled ${pulled}/${chunks.length}`);
  });

  test('private and non-http targets are refused before any request goes out', async () => {
    const fetchImpl = fakePages({});
    const items = [
      { link: 'http://127.0.0.1:8888/admin' },
      { link: 'http://169.254.169.254/latest/meta-data/' },
      { link: 'http://10.1.2.3/' },
      { link: 'ftp://ex.com/file' },
      { link: 'https://ex.com/ok' },
    ];
    await client({ fetchImpl }).enrich(items);
    assert.deepEqual(fetchImpl.calls, ['https://ex.com/ok']);
  });

  test('allowPrivateHosts opts back in for an intranet index', async () => {
    const fetchImpl = fakePages({ 'http://10.1.2.3/': PAGE_OG });
    const items = [{ link: 'http://10.1.2.3/' }] as { link: string; pagemap?: PageMap }[];
    await client({ fetchImpl, allowPrivateHosts: true }).enrich(items);
    assert.ok(items[0]!.pagemap);
  });
});

describe('isPrivateHost', () => {
  test('matches the ranges an SSRF attempt reaches for', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '::1', 'db.internal']) {
      assert.equal(isPrivateHost(host), true, host);
    }
  });

  test('leaves real public hosts alone', () => {
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'ex.co.uk']) {
      assert.equal(isPrivateHost(host), false, host);
    }
  });

  test('a name is not an IPv6 prefix', () => {
    for (const host of ['fdic.gov', 'fcbarcelona.com', 'fe80.example.com', 'fd-media.co']) {
      assert.equal(isPrivateHost(host), false, host);
    }
  });

  test('covers the IPv6 forms, including the mapped-IPv4 shorthand', () => {
    for (const host of ['fe80::1', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', '[::1]']) {
      assert.equal(isPrivateHost(host), true, host);
    }
    // What `new URL('http://[::ffff:127.0.0.1]/').hostname` actually produces.
    assert.equal(isPrivateHost('::ffff:7f00:1'), true);
    assert.equal(isPrivateHost('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateHost('::ffff:808:808'), false, '8.8.8.8 mapped is public');
    assert.equal(isPrivateHost('2606:4700::1111'), false);
  });

  test('refuses an IPv4-mapped loopback URL end to end', async () => {
    const pages = fakePages({});
    const c = client({ fetchImpl: pages.fetchImpl });
    const items = [{ link: 'http://[::ffff:127.0.0.1]/x' }, { link: 'http://2130706433/y' }];
    await c.enrich(items);
    assert.equal(pages.calls.length, 0);
    assert.equal(items[0]!.pagemap, undefined);
    assert.equal(items[1]!.pagemap, undefined);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('pagemap configuration', () => {
  test('is off by default, with Google-shaped defaults for the rest', () => {
    const config = loadConfig({});
    assert.equal(config.pagemap, false);
    assert.equal(config.pagemapMax, 10);
    assert.equal(config.pagemapTimeoutMs, 3000);
    assert.equal(config.pagemapTtlMs, 3_600_000);
    assert.equal(config.pagemapAllowPrivate, false);
  });

  test('CSE_BRIDGE_PAGEMAP=on turns it on', () => {
    assert.equal(loadConfig({ CSE_BRIDGE_PAGEMAP: 'on' }).pagemap, true);
    assert.equal(loadConfig({ CSE_BRIDGE_PAGEMAP: 'off' }).pagemap, false);
    assert.equal(loadConfig({ CSE_BRIDGE_PAGEMAP: 'true' }).pagemap, true);
  });

  test('an unreadable toggle is a startup error, not a silent off', () => {
    assert.throws(() => loadConfig({ CSE_BRIDGE_PAGEMAP: 'maybe' }), ConfigError);
  });

  test('the enrichment budget scales with the per-URL timeout unless set', () => {
    assert.equal(loadConfig({}).pagemapBudgetMs, 9000);
    assert.equal(loadConfig({ CSE_BRIDGE_PAGEMAP_TIMEOUT_MS: '5000' }).pagemapBudgetMs, 15_000);
    assert.equal(loadConfig({ CSE_BRIDGE_PAGEMAP_BUDGET_MS: '2500' }).pagemapBudgetMs, 2500);
  });

  test('empty strings fall back to the defaults, which is what compose passes', () => {
    const config = loadConfig({
      CSE_BRIDGE_PAGEMAP: '',
      CSE_BRIDGE_PAGEMAP_MAX: '',
      CSE_BRIDGE_PAGEMAP_TIMEOUT_MS: '',
      CSE_BRIDGE_PAGEMAP_BUDGET_MS: '',
      CSE_BRIDGE_PAGEMAP_TTL_MS: '',
      CSE_BRIDGE_PAGEMAP_ALLOW_PRIVATE: '',
    });
    assert.equal(config.pagemap, false);
    assert.equal(config.pagemapMax, 10);
    assert.equal(config.pagemapBudgetMs, 9000);
  });

  test('a profile may set pagemap, and an unreadable value is an error', () => {
    const profiles = profilesFromYaml('rich:\n  pagemap: true\nplain:\n  pagemap: false\nquiet:\n  categories: [general]\n', 't.yml');
    assert.equal(profiles.get('rich').pagemap, true);
    assert.equal(profiles.get('plain').pagemap, false);
    assert.equal(profiles.get('quiet').pagemap, undefined);
    assert.throws(() => profilesFromYaml('bad:\n  pagemap: sometimes\n', 't.yml'), ProfilesError);
  });
});

// ---------------------------------------------------------------------------
// Through the bridge
// ---------------------------------------------------------------------------

function fakeBackend(links: string[]): typeof fetch {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/') return new Response('<html>searxng</html>', { status: 200 });
    const pageno = Number(url.searchParams.get('pageno') ?? '1');
    const results: SearxngResult[] = pageno > 1 ? [] : links.map((link, i) => ({
      url: link,
      title: `Result ${i + 1}`,
      content: `Snippet ${i + 1}`,
      engine: 'fake',
    }));
    return new Response(
      JSON.stringify({ query: 'q', results, answers: [], corrections: [], infoboxes: [], suggestions: [], unresponsive_engines: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

async function startBridge(over: {
  env?: NodeJS.ProcessEnv;
  links: string[];
  pages: Record<string, string>;
  profilesYaml?: string;
}): Promise<{ bridge: Bridge; base: string; pageCalls: string[] }> {
  const config = loadConfig({ PORT: '0', SEARXNG_URL: 'http://searxng.test', ...over.env });
  const pageFetch = fakePages(over.pages);
  const bridge = createBridge({
    config,
    log: false,
    profiles: over.profilesYaml ? profilesFromYaml(over.profilesYaml, 'test.yml') : builtinProfiles(),
    client: new SearxngClient({
      baseUrl: config.searxngUrl,
      timeoutMs: config.timeoutMs,
      fetchImpl: fakeBackend(over.links),
    }),
    pagemap: new PagemapClient({
      maxUrls: config.pagemapMax,
      timeoutMs: config.pagemapTimeoutMs,
      budgetMs: config.pagemapBudgetMs,
      ttlMs: config.pagemapTtlMs,
      cacheMax: config.cacheMax,
      fetchImpl: pageFetch,
    }),
  });
  const { port } = await bridge.listen();
  return { bridge, base: `http://127.0.0.1:${port}`, pageCalls: pageFetch.calls };
}

describe('GET /customsearch/v1 with pagemap', () => {
  const links = ['https://ex.com/widgets', 'https://ex.com/bare'];
  const pages = { 'https://ex.com/widgets': PAGE_OG, 'https://ex.com/bare': PAGE_BARE };

  test('is off unless enabled: no pagemap key, and not one page fetched', async () => {
    const { bridge, base, pageCalls } = await startBridge({ links, pages });
    try {
      const body = await (await fetch(`${base}/customsearch/v1?key=k&cx=default&q=widgets&num=2`)).json();
      assert.equal(body.items.length, 2);
      for (const item of body.items) assert.equal('pagemap' in item, false);
      assert.deepEqual(pageCalls, []);
    } finally {
      await bridge.close();
    }
  });

  test('CSE_BRIDGE_PAGEMAP=on produces the worked example on the item', async () => {
    const { bridge, base } = await startBridge({ links, pages, env: { CSE_BRIDGE_PAGEMAP: 'on' } });
    try {
      const body = await (await fetch(`${base}/customsearch/v1?key=k&cx=default&q=widgets&num=2`)).json();
      assert.deepEqual(body.items[0].pagemap, {
        metatags: [
          { 'og:title': 'Widget Docs', 'og:image': 'https://ex.com/w.png', description: 'How widgets work' },
        ],
        cse_image: [{ src: 'https://ex.com/w.png' }],
        cse_thumbnail: [{ src: 'https://ex.com/w.png' }],
      });
      assert.equal('pagemap' in body.items[1], false, 'a page with nothing on it stays bare');
    } finally {
      await bridge.close();
    }
  });

  test('a profile wins over the environment, both ways', async () => {
    const yaml = 'default:\n  categories: [general]\nrich:\n  pagemap: true\nplain:\n  pagemap: false\n';

    const on = await startBridge({ links, pages, profilesYaml: yaml });
    try {
      const body = await (await fetch(`${on.base}/customsearch/v1?key=k&cx=rich&q=widgets&num=1`)).json();
      assert.ok(body.items[0].pagemap, 'pagemap: true overrides an unset environment');
    } finally {
      await on.bridge.close();
    }

    const off = await startBridge({ links, pages, profilesYaml: yaml, env: { CSE_BRIDGE_PAGEMAP: 'on' } });
    try {
      const body = await (await fetch(`${off.base}/customsearch/v1?key=k&cx=plain&q=widgets&num=1`)).json();
      assert.equal('pagemap' in body.items[0], false, 'pagemap: false overrides CSE_BRIDGE_PAGEMAP=on');
      assert.deepEqual(off.pageCalls, []);
    } finally {
      await off.bridge.close();
    }
  });

  test('a backend result the page fetch cannot reach still returns a normal response', async () => {
    const { bridge, base } = await startBridge({
      links: ['https://ex.com/gone'],
      pages: {},
      env: { CSE_BRIDGE_PAGEMAP: 'on' },
    });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=widgets&num=1`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items.length, 1);
      assert.equal('pagemap' in body.items[0], false);
    } finally {
      await bridge.close();
    }
  });

  test('/healthz reports the pagemap setting', async () => {
    const { bridge, base } = await startBridge({ links, pages, env: { CSE_BRIDGE_PAGEMAP: 'on' } });
    try {
      await fetch(`${base}/customsearch/v1?key=k&cx=default&q=widgets&num=2`);
      const health = await (await fetch(`${base}/healthz`)).json();
      assert.deepEqual(health.pagemap, { enabled: true, maxUrls: 10, cachedPages: 2 });
    } finally {
      await bridge.close();
    }
  });

  test('handleSearch without a pagemap client is unchanged', async () => {
    const config = loadConfig({ SEARXNG_URL: 'http://searxng.test', CSE_BRIDGE_PAGEMAP: 'on' });
    const body = await handleSearch(new URLSearchParams({ key: 'k', cx: 'default', q: 'widgets', num: '1' }), {
      config,
      profiles: builtinProfiles(),
      client: new SearxngClient({ baseUrl: config.searxngUrl, timeoutMs: 1000, fetchImpl: fakeBackend(links) }),
    });
    assert.equal('pagemap' in body.items![0]!, false);
  });
});
