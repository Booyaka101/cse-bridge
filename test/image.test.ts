/**
 * `searchType=image`: parameter validation, the SearXNG image-result mapping,
 * the gallery de-dupe fix, and the image/web cache separation.
 *
 * The two things a naive image mapper gets wrong:
 *  1. For image results SearXNG's `url` is the PAGE the image sits on, not the
 *     image. Google's `link` is the image itself (`img_src`); emitting a page
 *     URL as `link` breaks every client that hotlinks it into an <img>.
 *  2. Deduping on `url` collapses ten images from one gallery into one item.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge, type Bridge } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { SearxngClient, type SearxngResult } from '../src/searxng.ts';
import { profilesFromYaml, builtinProfiles } from '../src/profiles.ts';
import { parseParams } from '../src/params.ts';
import { mapImageItem, parseFilesize, parseResolution } from '../src/map.ts';
import { ApiError } from '../src/errors.ts';

/** The brief's worked example, exactly as SearXNG would emit it. */
const RED_PANDA: SearxngResult = {
  url: 'https://example.com/gallery/red-panda',
  title: 'Red panda',
  img_src: 'https://cdn.example.com/rp.jpg',
  thumbnail_src: 'https://cdn.example.com/rp_thumb.jpg',
  resolution: '1920 x 1080',
  img_format: 'jpg',
  filesize: '412 KB',
};

interface FakeOptions {
  /** Results served when categories=images. Defaults to a generated gallery. */
  imageResults?: SearxngResult[];
  imageTotal?: number;
  webTotal?: number;
  pageSize?: number;
  onUrl?: (url: URL) => void;
}

/**
 * A fake SearXNG that serves DIFFERENT result sets for the images category and
 * for everything else, the way a real instance does.
 */
function fakeBackend(opts: FakeOptions = {}): typeof fetch {
  const pageSize = opts.pageSize ?? 10;
  return async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    opts.onUrl?.(url);
    if (url.pathname === '/') {
      return new Response('<html>searxng</html>', { status: 200 });
    }
    const pageno = Number(url.searchParams.get('pageno') ?? '1');
    const first = (pageno - 1) * pageSize;
    const isImages = (url.searchParams.get('categories') ?? '').includes('images');

    let results: SearxngResult[];
    if (isImages && opts.imageResults !== undefined) {
      results = opts.imageResults.slice(first, first + pageSize);
    } else if (isImages) {
      const total = opts.imageTotal ?? 40;
      results = [];
      for (let i = first; i < Math.min(first + pageSize, total); i++) {
        results.push({
          url: `https://example.com/gallery/${i + 1}`,
          title: `Image ${i + 1}`,
          content: `Image number ${i + 1}`,
          img_src: `https://cdn.example.com/img-${i + 1}.png`,
          thumbnail_src: `https://cdn.example.com/thumb-${i + 1}.png`,
          resolution: '800 x 600',
          img_format: 'png',
          filesize: '100 KB',
        });
      }
    } else {
      const total = opts.webTotal ?? 40;
      results = [];
      for (let i = first; i < Math.min(first + pageSize, total); i++) {
        results.push({
          url: `https://example.com/doc/${i + 1}`,
          title: `Doc ${i + 1}`,
          content: `Snippet ${i + 1}`,
        });
      }
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
  fake?: FakeOptions;
  profilesYaml?: string;
} = {}): Promise<{ bridge: Bridge; base: string }> {
  const config = loadConfig({ PORT: '0', SEARXNG_URL: 'http://searxng.test' });
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

describe('searchType parameter validation', () => {
  const parse = (qs: string) => parseParams(new URLSearchParams(qs));

  test('searchType=image is accepted', () => {
    assert.equal(parse('q=x&cx=default&searchType=image').searchType, 'image');
  });

  test('absent searchType means a web search', () => {
    assert.equal(parse('q=x&cx=default').searchType, undefined);
  });

  test('searchType=video is rejected with Google\'s envelope', () => {
    assert.throws(
      () => parse('q=x&cx=default&searchType=video'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 400);
        assert.equal(err.status, 'INVALID_ARGUMENT');
        assert.equal(err.message, 'Request contains an invalid argument.');
        assert.match(err.detail, /searchType/);
        return true;
      },
    );
  });

  test('the four image filters accept exactly Google\'s enums', () => {
    const p = parse(
      'q=x&cx=default&searchType=image&imgSize=huge&imgType=photo&imgColorType=trans&imgDominantColor=teal',
    );
    assert.equal(p.imgSize, 'huge');
    assert.equal(p.imgType, 'photo');
    assert.equal(p.imgColorType, 'trans');
    assert.equal(p.imgDominantColor, 'teal');
  });

  test('out-of-enum filter values are rejected, as Google does', () => {
    for (const bad of ['imgSize=gigantic', 'imgType=painting', 'imgColorType=sepia', 'imgDominantColor=maroon']) {
      assert.throws(
        () => parse(`q=x&cx=default&searchType=image&${bad}`),
        (err: unknown) => err instanceof ApiError && err.code === 400 && err.status === 'INVALID_ARGUMENT',
        `${bad} must be rejected`,
      );
    }
  });

  test('the filters are valid without searchType=image, as on Google', () => {
    assert.equal(parse('q=x&cx=default&imgSize=icon').imgSize, 'icon');
  });
});

describe('parseResolution / parseFilesize', () => {
  test('the documented "1920 x 1080" form parses', () => {
    assert.deepEqual(parseResolution('1920 x 1080'), { width: 1920, height: 1080 });
  });

  test('spacing variants and the unicode multiplication sign parse', () => {
    assert.deepEqual(parseResolution('800x600'), { width: 800, height: 600 });
    assert.deepEqual(parseResolution('1024 × 768'), { width: 1024, height: 768 });
  });

  test('absent or malformed resolution yields nothing — never NaN', () => {
    assert.equal(parseResolution(undefined), undefined);
    assert.equal(parseResolution('unknown'), undefined);
    assert.equal(parseResolution(''), undefined);
  });

  test('filesize parses B, KB, MB and GB with 1 KB = 1024', () => {
    assert.equal(parseFilesize('412 KB'), 421888);
    assert.equal(parseFilesize('1.2 MB'), Math.round(1.2 * 1024 * 1024));
    assert.equal(parseFilesize('900 B'), 900);
    assert.equal(parseFilesize('1MB'), 1048576);
    assert.equal(parseFilesize('2 GB'), 2 * 1024 ** 3);
    assert.equal(parseFilesize('3 MiB'), 3 * 1024 ** 2);
  });

  test('unparseable filesize yields nothing — never a guess', () => {
    assert.equal(parseFilesize('huge'), undefined);
    assert.equal(parseFilesize(''), undefined);
    assert.equal(parseFilesize(undefined), undefined);
  });
});

describe('mapImageItem', () => {
  test('the worked example maps to exactly Google\'s image item', () => {
    assert.deepEqual(mapImageItem(RED_PANDA), {
      kind: 'customsearch#result',
      title: 'Red panda',
      htmlTitle: 'Red panda',
      link: 'https://cdn.example.com/rp.jpg',
      displayLink: 'cdn.example.com',
      snippet: 'Red panda',
      htmlSnippet: 'Red panda',
      mime: 'image/jpeg',
      fileFormat: 'image/jpeg',
      formattedUrl: 'https://cdn.example.com/rp.jpg',
      htmlFormattedUrl: 'https://cdn.example.com/rp.jpg',
      image: {
        contextLink: 'https://example.com/gallery/red-panda',
        thumbnailLink: 'https://cdn.example.com/rp_thumb.jpg',
        width: 1920,
        height: 1080,
        byteSize: 421888,
      },
    });
  });

  test('a result with no img_src is dropped entirely, never a page-link item', () => {
    assert.equal(mapImageItem({ url: 'https://example.com/gallery/x', title: 'x' }), null);
    assert.equal(mapImageItem({ url: 'https://example.com/gallery/x', img_src: '  ' }), null);
  });

  test('malformed resolution omits width and height — no NaN anywhere', () => {
    const item = mapImageItem({ ...RED_PANDA, resolution: 'unknown' });
    assert.ok(item);
    assert.ok(!('width' in item.image!));
    assert.ok(!('height' in item.image!));
    assert.ok(!JSON.stringify(item).includes('NaN'));
  });

  test('unparseable filesize omits byteSize', () => {
    const item = mapImageItem({ ...RED_PANDA, filesize: 'huge' });
    assert.ok(item);
    assert.ok(!('byteSize' in item.image!));
  });

  test('absent img_format omits mime and fileFormat', () => {
    const { img_format: _, ...rest } = RED_PANDA;
    const item = mapImageItem(rest as SearxngResult);
    assert.ok(item);
    assert.equal(item.mime, undefined);
    assert.equal(item.fileFormat, undefined);
    assert.ok(!('mime' in item));
    assert.ok(!('fileFormat' in item));
  });

  test('png stays png; only jpg is normalised to jpeg', () => {
    assert.equal(mapImageItem({ ...RED_PANDA, img_format: 'png' })!.mime, 'image/png');
    assert.equal(mapImageItem({ ...RED_PANDA, img_format: 'JPG' })!.mime, 'image/jpeg');
  });

  test('thumbnailWidth/thumbnailHeight are never synthesized', () => {
    const item = mapImageItem(RED_PANDA)!;
    assert.ok(!('thumbnailWidth' in item.image!));
    assert.ok(!('thumbnailHeight' in item.image!));
  });

  test('title and snippet fall back and escape exactly like web items', () => {
    const item = mapImageItem({
      url: 'https://example.com/page',
      img_src: 'https://cdn.example.com/a.jpg',
      title: 'Cats & <dogs>',
    });
    assert.ok(item);
    assert.equal(item.htmlTitle, 'Cats &amp; &lt;dogs&gt;');
    assert.equal(item.snippet, 'Cats & <dogs>', 'snippet falls back to the title');
    const untitled = mapImageItem({ url: 'https://example.com/page', img_src: 'https://cdn.example.com/a.jpg' });
    assert.equal(untitled!.title, 'cdn.example.com', 'title falls back to the display link');
  });
});

describe('GET /customsearch/v1?searchType=image over HTTP', () => {
  test('the worked example round-trips through the full stack', async () => {
    const { bridge, base } = await startBridge({ fake: { imageResults: [RED_PANDA] } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=red+panda&searchType=image&num=1`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kind, 'customsearch#search');
      assert.deepEqual(body.items[0], {
        kind: 'customsearch#result',
        title: 'Red panda',
        htmlTitle: 'Red panda',
        link: 'https://cdn.example.com/rp.jpg',
        displayLink: 'cdn.example.com',
        snippet: 'Red panda',
        htmlSnippet: 'Red panda',
        mime: 'image/jpeg',
        fileFormat: 'image/jpeg',
        formattedUrl: 'https://cdn.example.com/rp.jpg',
        htmlFormattedUrl: 'https://cdn.example.com/rp.jpg',
        image: {
          contextLink: 'https://example.com/gallery/red-panda',
          thumbnailLink: 'https://cdn.example.com/rp_thumb.jpg',
          width: 1920,
          height: 1080,
          byteSize: 421888,
        },
      });
      assert.equal(body.queries.request[0].searchType, 'image', 'searchType must round-trip in queries.request');
    } finally {
      await bridge.close();
    }
  });

  test('queries.request omits searchType on a web search', async () => {
    const { bridge, base } = await startBridge({});
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=test`);
      const body = await res.json();
      assert.ok(!('searchType' in body.queries.request[0]));
    } finally {
      await bridge.close();
    }
  });

  test('ten images from one gallery page stay ten distinct items (dedupe on img_src)', async () => {
    const gallery: SearxngResult[] = [];
    for (let i = 0; i < 10; i++) {
      gallery.push({
        url: 'https://example.com/gallery/red-panda', // one page, ten images
        title: `Red panda ${i + 1}`,
        img_src: `https://cdn.example.com/rp-${i + 1}.jpg`,
        img_format: 'jpg',
      });
    }
    const { bridge, base } = await startBridge({ fake: { imageResults: gallery } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=red+panda&searchType=image`);
      const body = await res.json();
      assert.equal(body.items.length, 10, 'gallery items must not collapse into one');
      const links = body.items.map((i: { link: string }) => i.link);
      assert.equal(new Set(links).size, 10);
    } finally {
      await bridge.close();
    }
  });

  test('searchType=image asks the backend for categories=images, superseding the profile', async () => {
    const seen: URL[] = [];
    const yaml = 'default:\n  categories: [news]\n';
    const { bridge, base } = await startBridge({ profilesYaml: yaml, fake: { onUrl: (u) => seen.push(u) } });
    try {
      await fetch(`${base}/customsearch/v1?key=k&cx=default&q=cats&searchType=image`);
      const searches = seen.filter((u) => u.pathname === '/search');
      assert.ok(searches.length > 0);
      for (const u of searches) assert.equal(u.searchParams.get('categories'), 'images');

      seen.length = 0;
      await fetch(`${base}/customsearch/v1?key=k&cx=default&q=cats`);
      const webSearches = seen.filter((u) => u.pathname === '/search');
      assert.equal(webSearches[0]!.searchParams.get('categories'), 'news', 'without searchType the profile stands');
    } finally {
      await bridge.close();
    }
  });

  test('image and web results for the same q come from separate cache entries', async () => {
    let fetches = 0;
    const { bridge, base } = await startBridge({ fake: { onUrl: (u) => { if (u.pathname === '/search') fetches++; } } });
    try {
      const webRes = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=panda`);
      const web = await webRes.json();
      const fetchesAfterWeb = fetches;

      const imgRes = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=panda&searchType=image`);
      const img = await imgRes.json();
      assert.ok(fetches > fetchesAfterWeb, 'the image search must hit the backend, not the web cache');

      const webLinks = new Set(web.items.map((i: { link: string }) => i.link));
      for (const item of img.items) {
        assert.ok(!webLinks.has(item.link), `image result ${item.link} leaked from the web result set`);
        assert.ok(item.image, 'every image item carries the image object');
        assert.equal(item.link.startsWith('https://cdn.example.com/'), true, 'link must be the image, not the page');
      }
    } finally {
      await bridge.close();
    }
  });

  test('imgSize=huge is accepted and inert; imgSize=gigantic is a 400', async () => {
    const seen: URL[] = [];
    const { bridge, base } = await startBridge({ fake: { onUrl: (u) => seen.push(u) } });
    try {
      const ok = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=cats&searchType=image&imgSize=huge`);
      assert.equal(ok.status, 200);
      for (const u of seen.filter((x) => x.pathname === '/search')) {
        assert.equal(u.searchParams.get('imgSize'), null, 'no invented backend parameter');
      }

      const bad = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=cats&searchType=image&imgSize=gigantic`);
      assert.equal(bad.status, 400);
      const body = await bad.json();
      assert.equal(body.error.status, 'INVALID_ARGUMENT');
      assert.equal(body.error.errors[0].reason, 'badRequest');
      assert.match(body.error.errors[0].message, /imgSize/);
    } finally {
      await bridge.close();
    }
  });

  test('searchType=video returns Google\'s exact 400 envelope over HTTP', async () => {
    const { bridge, base } = await startBridge({});
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=cats&searchType=video`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 400);
      assert.equal(body.error.message, 'Request contains an invalid argument.');
      assert.equal(body.error.status, 'INVALID_ARGUMENT');
      assert.equal(body.error.errors[0].domain, 'global');
      assert.equal(body.error.errors[0].reason, 'badRequest');
    } finally {
      await bridge.close();
    }
  });

  test('zero image results: items is ABSENT, not []', async () => {
    const { bridge, base } = await startBridge({ fake: { imageResults: [] } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=zzzz&searchType=image`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!('items' in body));
      assert.equal(body.searchInformation.totalResults, '0');
    } finally {
      await bridge.close();
    }
  });

  test('results with only page urls (no img_src) yield an item-less response, never page links', async () => {
    const pageOnly: SearxngResult[] = [
      { url: 'https://example.com/gallery/a', title: 'a' },
      { url: 'https://example.com/gallery/b', title: 'b' },
    ];
    const { bridge, base } = await startBridge({ fake: { imageResults: pageOnly } });
    try {
      const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=cats&searchType=image`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(!('items' in body), 'an image item must never link to an HTML page');
    } finally {
      await bridge.close();
    }
  });

  test('pagination walks the image result set: start=1 and start=11 are disjoint', async () => {
    const { bridge, base } = await startBridge({ fake: { imageTotal: 40 } });
    try {
      const pages = await Promise.all(
        [1, 11].map(async (start) => {
          const res = await fetch(
            `${base}/customsearch/v1?key=k&cx=default&q=pandas&searchType=image&start=${start}`,
          );
          assert.equal(res.status, 200);
          const body = await res.json();
          assert.equal(body.queries.request[0].searchType, 'image');
          return (body.items ?? []).map((i: { link: string }) => i.link) as string[];
        }),
      );
      const all = pages.flat();
      assert.equal(all.length, 20);
      assert.equal(new Set(all).size, 20, 'image pages overlapped');
      for (const link of all) assert.match(link, /^https:\/\/cdn\.example\.com\//);
    } finally {
      await bridge.close();
    }
  });
});

/** Live checks against a real SearXNG, same gate as integration.test.ts. */
const live = process.env['CSE_BRIDGE_LIVE'] === '1';

describe('live SearXNG image search', { skip: live ? false : 'set CSE_BRIDGE_LIVE=1 to run' }, () => {
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

  test('searchType=image returns real image items in Google\'s shape', async () => {
    const res = await fetch(`${base}/customsearch/v1?key=k&cx=default&q=red+panda&searchType=image&num=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, 'customsearch#search');
    assert.equal(body.queries.request[0].searchType, 'image');
    assert.ok((body.items ?? []).length > 0, 'a live image search should find something');
    // Note: link CAN legitimately equal contextLink when the image is directly
    // linkable (e.g. an engine serving a bare .svg URL as both) — what must
    // never happen is `image` present while `link` came from anything but
    // img_src, which the offline suite pins down.
    for (const item of body.items) {
      assert.ok(typeof item.link === 'string' && item.link.length > 0);
      assert.ok(item.image, 'every image item carries image');
      assert.ok(typeof item.image.contextLink === 'string' && item.image.contextLink.length > 0);
    }
  });
});
