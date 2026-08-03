/**
 * End-to-end over real HTTP: a real node:http server, real sockets, real JSON.
 *
 * The SearXNG backend is faked here so the suite runs offline and
 * deterministically. The LIVE block at the bottom runs the same assertions
 * against a real instance when SEARXNG_URL is exported.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge, type Bridge } from '../src/server.ts';
import { loadConfig, ConfigError } from '../src/config.ts';
import { SearxngClient, type SearxngResult } from '../src/searxng.ts';
import { profilesFromYaml, parseYaml, builtinProfiles, loadProfiles, ProfilesError } from '../src/profiles.ts';

interface FakeOptions {
  total?: number;
  pageSize?: number;
  status?: number;
  body?: string;
  throwError?: Error;
  onUrl?: (url: URL) => void;
}

function fakeBackend(opts: FakeOptions = {}): typeof fetch {
  const total = opts.total ?? 40;
  const pageSize = opts.pageSize ?? 10;
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    opts.onUrl?.(url);
    if (opts.throwError) throw opts.throwError;
    // The cheap liveness probe hits `/`, not `/search`.
    if (url.pathname === '/' && opts.status === undefined && opts.body === undefined) {
      return new Response('<html>searxng</html>', { status: 200 });
    }
    if (opts.status !== undefined && opts.status !== 200) {
      return new Response(opts.body ?? '', { status: opts.status });
    }
    if (opts.body !== undefined) {
      return new Response(opts.body, { status: 200 });
    }
    const pageno = Number(url.searchParams.get('pageno') ?? '1');
    const first = (pageno - 1) * pageSize;
    const results: SearxngResult[] = [];
    for (let i = first; i < Math.min(first + pageSize, total); i++) {
      results.push({
        url: `https://example.com/doc/${i + 1}`,
        title: `Async runtime ${i + 1} <tokio> & friends`,
        content: `Snippet number ${i + 1} describing "async" & <runtimes>.`,
        engine: 'fake',
      });
    }
    return new Response(
      JSON.stringify({
        query: url.searchParams.get('q'),
        results,
        answers: [],
        corrections: [],
        infoboxes: [],
        suggestions: [],
        unresponsive_engines: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

async function startBridge(over: {
  env?: NodeJS.ProcessEnv;
  fake?: FakeOptions;
  profilesYaml?: string;
}): Promise<{ bridge: Bridge; base: string }> {
  const config = loadConfig({ PORT: '0', SEARXNG_URL: 'http://searxng.test', ...over.env });
  const bridge = createBridge({
    config,
    log: false,
    profiles: over.profilesYaml ? profilesFromYaml(over.profilesYaml, 'test.yml') : builtinProfiles(),
    client: new SearxngClient({
      baseUrl: config.searxngUrl,
      timeoutMs: config.timeoutMs,
      fetchImpl: fakeBackend(over.fake),
    }),
  });
  const { port } = await bridge.listen();
  return { bridge, base: `http://127.0.0.1:${port}` };
}

describe('GET /customsearch/v1 — the worked example', () => {
  let bridge: Bridge;
  let base: string;

  before(async () => {
    ({ bridge, base } = await startBridge({}));
  });
  after(async () => {
    await bridge.close();
  });

  test('returns a customsearch#search body over real HTTP', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=rust%20async%20runtime&num=3`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);

    const body = await res.json();
    assert.equal(body.kind, 'customsearch#search');

    const total = Number.parseInt(body.searchInformation.totalResults, 10);
    assert.ok(Number.isInteger(total) && total >= 3, `totalResults must parse as an integer >= 3, got ${total}`);

    assert.equal(body.items.length, 3);
    for (const item of body.items) {
      for (const field of [
        'title',
        'htmlTitle',
        'link',
        'displayLink',
        'snippet',
        'htmlSnippet',
        'formattedUrl',
        'htmlFormattedUrl',
      ]) {
        assert.ok(typeof item[field] === 'string' && item[field].length > 0, `${field} was empty`);
      }
    }

    const displayLink = body.items[0].displayLink;
    assert.ok(!displayLink.includes('://'), 'displayLink must contain no scheme');
    assert.ok(!displayLink.includes('/'), 'displayLink must contain no path');
    assert.equal(displayLink, 'example.com');

    // The escaped variants really are escaped.
    assert.ok(body.items[0].htmlTitle.includes('&lt;tokio&gt;'));
    assert.ok(body.items[0].htmlSnippet.includes('&quot;async&quot;'));
  });

  test('start=1, 11 and 21 return disjoint link sets over HTTP', async () => {
    const pages = await Promise.all(
      [1, 11, 21].map(async (start) => {
        const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test&start=${start}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        return (body.items ?? []).map((i: { link: string }) => i.link) as string[];
      }),
    );
    const all = pages.flat();
    assert.equal(all.length, 30);
    assert.equal(new Set(all).size, 30);
  });

  test('num=20 is clamped rather than rejected', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test&num=20`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 10);
    assert.equal(body.queries.request[0].count, 10);
  });

  test('HEAD is accepted like GET', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });
});

describe('error envelopes over HTTP', () => {
  let bridge: Bridge;
  let base: string;
  before(async () => {
    ({ bridge, base } = await startBridge({}));
  });
  after(async () => {
    await bridge.close();
  });

  test('start=92 returns Google\'s exact 400 envelope', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test&start=92`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 400);
    assert.equal(body.error.message, 'Request contains an invalid argument.');
    assert.equal(body.error.status, 'INVALID_ARGUMENT');
    assert.equal(body.error.errors.length, 1);
    assert.equal(body.error.errors[0].domain, 'global');
    assert.equal(body.error.errors[0].reason, 'badRequest');
    assert.ok(body.error.errors[0].message.length > 0);
  });

  test('a missing q never produces a stack trace', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default`);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('at '), 'no stack frames may leak to the client');
    assert.ok(!/\.ts:\d+/.test(text));
    assert.equal(JSON.parse(text).error.status, 'INVALID_ARGUMENT');
  });

  test('an unknown path returns a 404 envelope, not HTML', async () => {
    const res = await fetch(`${base}/v1/search?q=x`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 404);
    assert.equal(body.error.status, 'NOT_FOUND');
    assert.match(body.error.errors[0].message, /customsearch\/v1/);
  });

  test('POST is refused with an envelope', async () => {
    const res = await fetch(`${base}/customsearch/v1?q=a&cx=default`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.status, 'NOT_FOUND');
  });
});

describe('backend failures map to Google status codes', () => {
  test('SearXNG 429 becomes 429 RESOURCE_EXHAUSTED', async () => {
    const { bridge, base } = await startBridge({ fake: { status: 429 } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      assert.equal(res.status, 429);
      const body = await res.json();
      assert.equal(body.error.code, 429);
      assert.equal(body.error.status, 'RESOURCE_EXHAUSTED');
      assert.equal(body.error.errors[0].reason, 'rateLimitExceeded');
      assert.match(body.error.errors[0].message, /rate limiting/i);
    } finally {
      await bridge.close();
    }
  });

  test('an unreachable SearXNG becomes 503 UNAVAILABLE', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8888'), { name: 'TypeError' });
    const { bridge, base } = await startBridge({ fake: { throwError: err } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error.code, 503);
      assert.equal(body.error.status, 'UNAVAILABLE');
      assert.equal(body.error.errors[0].reason, 'backendError');
      assert.match(body.error.errors[0].message, /unreachable/i);
    } finally {
      await bridge.close();
    }
  });

  test('a timeout becomes 503 with a message naming the timeout', async () => {
    const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { bridge, base } = await startBridge({ fake: { throwError: err } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error.errors[0].message, /did not respond within/);
    } finally {
      await bridge.close();
    }
  });

  test('SearXNG serving HTML (json not in search.formats) is diagnosed precisely', async () => {
    const { bridge, base } = await startBridge({ fake: { body: '<!DOCTYPE html><html><body>results</body></html>' } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      assert.equal(res.status, 503);
      const message = (await res.json()).error.errors[0].message;
      assert.match(message, /returned HTML, not JSON/);
      assert.match(message, /formats/, 'the fix must be in the message, not just the docs');
    } finally {
      await bridge.close();
    }
  });

  test('SearXNG 403 (limiter/botdetection) is diagnosed, not reported as success', async () => {
    const { bridge, base } = await startBridge({ fake: { status: 403 } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error.errors[0].message, /limiter|botdetection/i);
    } finally {
      await bridge.close();
    }
  });

  test('valid JSON without a results array is refused', async () => {
    const { bridge, base } = await startBridge({ fake: { body: '{"query":"x"}' } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error.errors[0].message, /'results' array/);
    } finally {
      await bridge.close();
    }
  });

  test('a backend with no results yields 200 with no items', async () => {
    const { bridge, base } = await startBridge({ fake: { total: 0 } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=zzzzz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items, undefined);
      assert.equal(body.searchInformation.totalResults, '0');
      assert.equal(body.kind, 'customsearch#search');
    } finally {
      await bridge.close();
    }
  });
});

describe('API key checking', () => {
  test('with CSE_BRIDGE_KEYS unset, any key (or none) is accepted', async () => {
    const { bridge, base } = await startBridge({});
    try {
      assert.equal((await fetch(`${base}/customsearch/v1?cx=default&q=test`)).status, 200);
      assert.equal((await fetch(`${base}/customsearch/v1?key=anything&cx=default&q=test`)).status, 200);
    } finally {
      await bridge.close();
    }
  });

  test('with CSE_BRIDGE_KEYS set, only listed keys pass', async () => {
    const { bridge, base } = await startBridge({ env: { CSE_BRIDGE_KEYS: 'good-key, second-key' } });
    try {
      assert.equal((await fetch(`${base}/customsearch/v1?key=good-key&cx=default&q=test`)).status, 200);
      assert.equal((await fetch(`${base}/customsearch/v1?key=second-key&cx=default&q=test`)).status, 200);

      const bad = await fetch(`${base}/customsearch/v1?key=nope&cx=default&q=test`);
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.equal(badBody.error.message, 'API key not valid. Please pass a valid API key.');
      assert.equal(badBody.error.status, 'INVALID_ARGUMENT');

      const missing = await fetch(`${base}/customsearch/v1?cx=default&q=test`);
      assert.equal(missing.status, 403);
      const missingBody = await missing.json();
      assert.equal(missingBody.error.message, 'The request is missing a valid API key.');
      assert.equal(missingBody.error.status, 'PERMISSION_DENIED');
    } finally {
      await bridge.close();
    }
  });
});

describe('profiles', () => {
  const yaml = `
default:
  description: General
  categories: [general]

docs:
  categories: [general]
  site: docs.rs
  language: en

news:
  categories:
    - news
    - general
`;

  test('the tiny YAML parser handles both list styles, comments and quotes', () => {
    const doc = parseYaml(`
# leading comment
alpha:
  engines: [a, b]   # inline comment
  site: "example.com"
beta:
  categories:
    - news
    - it
  site: null
`);
    assert.deepEqual(doc['alpha'], { engines: ['a', 'b'], site: 'example.com' });
    assert.deepEqual(doc['beta'], { categories: ['news', 'it'], site: null });
  });

  test('malformed YAML is an error, never a silent wrong backend', () => {
    assert.throws(() => parseYaml('just a line with no colon'), ProfilesError);
    assert.throws(() => parseYaml('top: value\n'), ProfilesError);
    assert.throws(() => parseYaml('  orphan: 1\n'), ProfilesError);
  });

  test('a missing profiles file falls back to the built-in default', () => {
    const set = loadProfiles('D:/definitely/not/here/profiles.yml');
    assert.deepEqual(set.names(), ['default']);
    assert.equal(set.source, null);
    assert.equal(set.get('anything').site, undefined);
  });

  test('an unknown cx falls back to the default profile', () => {
    const set = profilesFromYaml(yaml, 'test.yml');
    assert.equal(set.get('docs').site, 'docs.rs');
    assert.equal(set.get('012345678901234567890:abcdefghij').site, undefined);
    assert.equal(set.get('unknown').categories[0], 'general');
  });

  test('the profile\'s site really reaches the backend query', async () => {
    const seen: URL[] = [];
    const { bridge, base } = await startBridge({
      profilesYaml: yaml,
      fake: { onUrl: (u) => seen.push(u) },
    });
    try {
      await fetch(`${base}/customsearch/v1?key=k&cx=docs&q=tokio`);
      assert.ok(seen.length > 0);
      assert.equal(seen[0]!.searchParams.get('q'), 'tokio site:docs.rs');
      assert.equal(seen[0]!.searchParams.get('language'), 'en');
      assert.equal(seen[0]!.searchParams.get('format'), 'json');

      seen.length = 0;
      // A Google-shaped cx nobody configured must still work.
      await fetch(`${base}/customsearch/v1?key=k&cx=a1b2c3d4e5f6g7h8i&q=tokio`);
      assert.equal(seen[0]!.searchParams.get('q'), 'tokio', 'unknown cx must not inherit another profile\'s site');
    } finally {
      await bridge.close();
    }
  });

  test('CSE params reach SearXNG as the documented backend params', async () => {
    const seen: URL[] = [];
    const { bridge, base } = await startBridge({ fake: { onUrl: (u) => seen.push(u) } });
    try {
      await fetch(
        `${base}/customsearch/v1?key=k&cx=default&q=cats&hl=de&safe=active&dateRestrict=d1&fileType=pdf&excludeTerms=dogs`,
      );
      const u = seen[0]!;
      assert.equal(u.pathname, '/search');
      assert.equal(u.searchParams.get('format'), 'json');
      assert.equal(u.searchParams.get('language'), 'de');
      assert.equal(u.searchParams.get('safesearch'), '2');
      assert.equal(u.searchParams.get('time_range'), 'day');
      assert.equal(u.searchParams.get('pageno'), '1');
      assert.equal(u.searchParams.get('q'), 'cats filetype:pdf -dogs');
    } finally {
      await bridge.close();
    }
  });
});

describe('GET /healthz', () => {
  test('reports ok and the resolved configuration when the backend answers', async () => {
    const { bridge, base } = await startBridge({ profilesYaml: 'default:\n  categories: [general]\ndocs:\n  site: docs.rs\n' });
    try {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.service, 'cse-bridge');
      assert.equal(body.searxng.status, 'ok');
      assert.equal(body.searxng.probe, 'liveness');
      assert.deepEqual(body.profiles, ['default', 'docs']);
      assert.equal(body.authRequired, false);
      assert.match(body.version, /^\d+\.\d+\.\d+$/);
    } finally {
      await bridge.close();
    }
  });

  test('the default probe does NOT fire a search at the upstream engines', async () => {
    const paths: string[] = [];
    const { bridge, base } = await startBridge({ fake: { onUrl: (u) => paths.push(u.pathname) } });
    try {
      await fetch(`${base}/healthz`);
      assert.deepEqual(paths, ['/'], 'a 30s container healthcheck must not run a real query');

      paths.length = 0;
      const deep = await fetch(`${base}/healthz?deep=1`);
      assert.equal(deep.status, 200);
      assert.deepEqual(paths, ['/search']);
      assert.match((await deep.json()).searxng.detail, /format=json/);
    } finally {
      await bridge.close();
    }
  });

  test('reports degraded with a 503 when the backend is down', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
    const { bridge, base } = await startBridge({ fake: { throwError: err } });
    try {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.status, 'degraded');
      assert.equal(body.searxng.status, 'unreachable');
      assert.match(body.searxng.detail, /unreachable/i);
    } finally {
      await bridge.close();
    }
  });
});

describe('config', () => {
  test('defaults are usable with an empty environment', () => {
    const c = loadConfig({});
    assert.equal(c.searxngUrl, 'http://localhost:8888');
    assert.equal(c.port, 8080);
    assert.equal(c.keys.size, 0);
    assert.equal(c.profilesFile, 'profiles.yml');
  });

  test('a trailing slash on SEARXNG_URL does not produce a double slash', () => {
    assert.equal(loadConfig({ SEARXNG_URL: 'http://searxng:8080/' }).searxngUrl, 'http://searxng:8080');
    assert.equal(loadConfig({ SEARXNG_URL: 'http://host/searx//' }).searxngUrl, 'http://host/searx');
  });

  test('bad configuration fails loudly at startup', () => {
    assert.throws(() => loadConfig({ SEARXNG_URL: 'not a url' }), ConfigError);
    assert.throws(() => loadConfig({ SEARXNG_URL: 'ftp://host' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: 'eighty' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: '99999' }), ConfigError);
    assert.throws(() => loadConfig({ CSE_BRIDGE_TIMEOUT_MS: '0' }), ConfigError);
  });

  test('CSE_BRIDGE_KEYS is split, trimmed and de-blanked', () => {
    const c = loadConfig({ CSE_BRIDGE_KEYS: ' a , b ,, c ' });
    assert.deepEqual([...c.keys].sort(), ['a', 'b', 'c']);
  });
});

/**
 * Live checks against a real SearXNG. Skipped unless CSE_BRIDGE_LIVE=1 and
 * SEARXNG_URL point at a running instance with `json` in search.formats:
 *
 *   docker compose up -d
 *   CSE_BRIDGE_LIVE=1 SEARXNG_URL=http://localhost:8888 npm test
 */
const live = process.env['CSE_BRIDGE_LIVE'] === '1';

describe('live SearXNG', { skip: live ? false : 'set CSE_BRIDGE_LIVE=1 to run' }, () => {
  let bridge: Bridge;
  let base: string;

  before(async () => {
    const config = loadConfig({ PORT: '0', SEARXNG_URL: process.env['SEARXNG_URL'] ?? 'http://localhost:8888' });
    bridge = createBridge({ config, log: false, profiles: builtinProfiles() });
    const { port } = await bridge.listen();
    base = `http://127.0.0.1:${port}`;
  });
  after(async () => {
    await bridge?.close();
  });

  test('the worked example returns real results', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=rust%20async%20runtime&num=3`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, 'customsearch#search');
    assert.equal(body.items.length, 3);
    assert.ok(Number.parseInt(body.searchInformation.totalResults, 10) >= 3);
    assert.ok(!body.items[0].displayLink.includes('/'));
  });

  test('start=1, 11, 21 are disjoint against a real instance', async () => {
    const sets: string[][] = [];
    for (const start of [1, 11, 21]) {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=typescript&start=${start}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      sets.push((body.items ?? []).map((i: { link: string }) => i.link));
    }
    const all = sets.flat();
    assert.ok(all.length >= 20, `expected at least 20 results across three pages, got ${all.length}`);
    assert.equal(new Set(all).size, all.length, 'live pages overlapped');
  });

  test('healthz reports the real backend as ok', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).searxng.status, 'ok');
  });
});
