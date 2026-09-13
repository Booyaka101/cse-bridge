/**
 * Opt-in `pagemap` reconstruction.
 *
 * Google's own documentation says where most of a PageMap comes from: "Google
 * will also use other information on a page, such as rich snippets markup or
 * `meta` tag data, to create a PageMap." That information is still on the page,
 * so the bridge can rebuild the parts of `item.pagemap` that clients actually
 * read — `metatags[0]['og:description']`, `cse_thumbnail[0].src` — by fetching
 * the result page and reading its head.
 *
 * What this is NOT: Google's index. Anything Google synthesized rather than
 * read off the page (its own crop dimensions for `cse_thumbnail`, DataObjects
 * built from crawl-time signals) is absent here, and is left absent rather than
 * guessed — the same posture as `totalResults` and `image.thumbnailWidth`.
 *
 * The parsing is deliberately regex plus `JSON.parse`, with no HTML parser
 * dependency. It reads the document head only and stops the download at
 * `</head>`, which is both the cheap thing to do and the reason structured data
 * placed late in the body is not picked up.
 */

import { trim } from './cache.ts';
import { USER_AGENT } from './searxng.ts';

/** One DataObject: Google's `Attribute name/value` pairs, flattened to JSON. */
export type PagemapAttributes = Record<string, string>;

/** Google's `item.pagemap`: DataObject type -> one entry per occurrence. */
export type PageMap = Record<string, PagemapAttributes[]>;

export const DEFAULT_PAGEMAP_MAX = 10;
export const DEFAULT_PAGEMAP_TIMEOUT_MS = 3000;
export const DEFAULT_PAGEMAP_TTL_MS = 3_600_000;

/** Simultaneous page fetches per bridge request. */
export const PAGEMAP_CONCURRENCY = 4;
export const MAX_REDIRECTS = 2;
export const MAX_BODY_BYTES = 512 * 1024;

/** Google converts at most 50 meta tags, none longer than 1024 characters. */
export const MAX_ATTRIBUTES = 50;
export const MAX_ATTRIBUTE_CHARS = 1024;

/** Our own ceiling, so a page cannot inflate one item without bound. */
export const MAX_DATA_OBJECTS = 32;

const HTML_CONTENT_TYPE = /^\s*(?:text\/html|application\/xhtml\+xml)\b/i;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Everything up to and including `</head>`, or the whole input when the tag
 * never appears. The document prologue is kept because `<html itemscope
 * itemtype=...>` sits above `<head>`.
 */
export function headOf(html: string): string {
  const end = /<\/head\s*>/i.exec(html);
  return end === null ? html : html.slice(0, end.index + end[0].length);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/**
 * The inside of one tag with quoted values respected, so `content="a > b"` does
 * not end the tag early and lose the whole meta. The three branches begin with
 * different characters, which keeps matching linear on malformed markup.
 */
const TAG_BODY = String.raw`(?:"[^"]*"|'[^']*'|[^>"'])*`;
const META_RE = new RegExp(String.raw`<meta\b(${TAG_BODY})>`, 'gi');
const SCRIPT_RE = new RegExp(String.raw`<script\b(${TAG_BODY})>([\s\S]*?)</script\s*>`, 'gi');
const ELEMENT_RE = new RegExp(String.raw`<([a-zA-Z][a-zA-Z0-9-]*)\b(${TAG_BODY})>`, 'g');
const DATA_OBJECT_RE = new RegExp(String.raw`<DataObject\b(${TAG_BODY})>([\s\S]*?)</DataObject\s*>`, 'gi');
// Lazy body here so the self-closing branch wins: a greedy one would swallow
// the `/` and run the text-content branch on to the NEXT Attribute's close.
const PAGEMAP_ATTRIBUTE_RE = new RegExp(String.raw`<Attribute\b(${TAG_BODY}?)(?:/>|>([\s\S]*?)</Attribute\s*>)`, 'gi');

/** Attribute name (lowercased) -> decoded value, for the inside of one tag. */
export function attributesOf(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE_RE.exec(tagBody)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

/** A value fit to emit: non-empty, and inside Google's per-property limit. */
function acceptableValue(raw: unknown): string | undefined {
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  // Over-long values are dropped, not truncated: half a description is data we
  // made up. Same reason the image mapper omits a dimension it cannot read.
  if (value.length === 0 || value.length > MAX_ATTRIBUTE_CHARS) return undefined;
  return value;
}

function addDataObject(map: PageMap, type: string, attributes: PagemapAttributes): void {
  if (Object.keys(attributes).length === 0) return;
  if (countDataObjects(map) >= MAX_DATA_OBJECTS) return;
  const bucket = map[type];
  if (bucket === undefined) map[type] = [attributes];
  else bucket.push(attributes);
}

function countDataObjects(map: PageMap): number {
  let n = 0;
  for (const bucket of Object.values(map)) n += bucket.length;
  return n;
}

/**
 * The `metatags` DataObject, which Google creates automatically from the page's
 * meta tags.
 *
 * Keys follow what the JSON API actually returns: a `property` attribute keeps
 * the case the page wrote (`og:title` stays `og:title`), a bare `name` is
 * lowercased. First occurrence of a key wins, so a page repeating `og:image`
 * does not shuffle depending on tag order.
 */
export function metatagsFrom(head: string): PagemapAttributes | undefined {
  const out: PagemapAttributes = {};
  for (const m of head.matchAll(META_RE)) {
    if (Object.keys(out).length >= MAX_ATTRIBUTES) break;
    const attrs = attributesOf(m[1]!);
    const property = attrs['property'];
    const name = attrs['name'];
    const key = property !== undefined && property.trim().length > 0 ? property.trim() : name?.trim().toLowerCase();
    if (key === undefined || key.length === 0 || key in out) continue;
    const value = acceptableValue(attrs['content']);
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `https://schema.org/NewsArticle` -> `newsarticle`. */
function typeName(raw: string): string | undefined {
  const last = raw.trim().split(/[/#]/).pop();
  if (last === undefined) return undefined;
  const name = last.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]*$/.test(name) ? name : undefined;
}

function typeOf(node: Record<string, unknown>): string | undefined {
  const raw = node['@type'];
  if (typeof raw === 'string') return typeName(raw);
  if (Array.isArray(raw)) {
    for (const t of raw) if (typeof t === 'string') return typeName(t);
  }
  return undefined;
}

/**
 * Walk a parsed JSON-LD document, emitting one DataObject per typed node.
 *
 * Nested typed nodes become their own DataObjects — `author: {@type: Person}`
 * shows up as a `person` entry, which is what Google does. Untyped nested
 * objects are skipped rather than flattened, because naming their fields would
 * be our invention rather than the page's.
 */
function collectJsonLd(value: unknown, map: PageMap, depth: number): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLd(entry, map, depth + 1);
    return;
  }

  const node = value as Record<string, unknown>;
  const type = typeOf(node);
  if (type !== undefined) {
    const attributes: PagemapAttributes = {};
    for (const [key, raw] of Object.entries(node)) {
      if (key.startsWith('@')) continue;
      if (Object.keys(attributes).length >= MAX_ATTRIBUTES) break;
      const scalar = Array.isArray(raw) ? raw.find((v) => acceptableValue(v) !== undefined) : raw;
      const attrValue = acceptableValue(scalar);
      if (attrValue === undefined) continue;
      attributes[key.toLowerCase()] = attrValue;
    }
    addDataObject(map, type, attributes);
  }

  for (const raw of Object.values(node)) collectJsonLd(raw, map, depth + 1);
}

export function addJsonLd(head: string, map: PageMap): void {
  for (const m of head.matchAll(SCRIPT_RE)) {
    const attrs = attributesOf(m[1]!);
    if (!/\bld\+json\b/i.test(attrs['type'] ?? '')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[2]!);
    } catch {
      // A page with broken JSON-LD is common and is not our problem to report.
      continue;
    }
    collectJsonLd(parsed, map, 0);
  }
}

/**
 * Microdata in the head region: `itemtype` names the DataObject, `itemprop`
 * tags that follow it supply the attributes.
 *
 * Proper microdata scoping needs a DOM; each `itemprop` is attributed to the
 * nearest preceding `itemtype` in document order instead, which is correct for
 * the flat `<meta itemprop>` markup that appears in a head and is the reason
 * nested item scopes are a documented non-goal.
 */
export function addMicrodata(head: string, map: PageMap): void {
  let current: { type: string; attributes: PagemapAttributes } | null = null;
  const flush = (): void => {
    if (current !== null) addDataObject(map, current.type, current.attributes);
    current = null;
  };

  for (const m of head.matchAll(ELEMENT_RE)) {
    const body = m[2]!;
    if (!/\bitem(type|prop)\s*=/i.test(body)) continue;
    const attrs = attributesOf(body);

    const itemtype = attrs['itemtype'];
    if (itemtype !== undefined) {
      flush();
      const type = typeName(itemtype);
      if (type !== undefined) current = { type, attributes: {} };
    }

    const itemprop = attrs['itemprop']?.trim().toLowerCase();
    if (current === null || itemprop === undefined || itemprop.length === 0) continue;
    if (itemprop in current.attributes || Object.keys(current.attributes).length >= MAX_ATTRIBUTES) continue;
    const value = acceptableValue(attrs['content'] ?? attrs['href'] ?? attrs['src']);
    if (value !== undefined) current.attributes[itemprop] = value;
  }
  flush();
}

/**
 * A literal `<PageMap>` block, which Google documents as an HTML comment in the
 * head. Read from the uncommented head so both forms work, and it overwrites
 * anything we derived for the same DataObject type: the author stating their
 * own PageMap beats our reconstruction of it.
 */
export function addLiteralPageMap(head: string, map: PageMap): void {
  const block = /<PageMap\s*>([\s\S]*?)<\/PageMap\s*>/i.exec(head);
  if (block === null) return;

  const claimed = new Set<string>();
  for (const obj of block[1]!.matchAll(DATA_OBJECT_RE)) {
    const type = typeName(attributesOf(obj[1]!)['type'] ?? '');
    if (type === undefined) continue;

    const attributes: PagemapAttributes = {};
    for (const attr of obj[2]!.matchAll(PAGEMAP_ATTRIBUTE_RE)) {
      const parsed = attributesOf(attr[1]!);
      const name = parsed['name']?.trim().toLowerCase();
      if (name === undefined || name.length === 0 || name in attributes) continue;
      if (Object.keys(attributes).length >= MAX_ATTRIBUTES) break;
      // Google documents both `<Attribute name value="x"/>` and text content.
      const value = acceptableValue(parsed['value'] ?? decodeEntities(attr[2] ?? ''));
      if (value !== undefined) attributes[name] = value;
    }
    if (Object.keys(attributes).length === 0) continue;

    if (!claimed.has(type)) {
      claimed.add(type);
      delete map[type];
    }
    addDataObject(map, type, attributes);
  }
}

/** Meta keys carrying a page's own image, best first. */
const IMAGE_META_KEYS = ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];

/** Absolute http(s) form of a page-supplied URL, or nothing. */
function absoluteUrl(raw: string | undefined, base: string): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const url = new URL(raw.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rebuild `item.pagemap` from one page's head. Returns nothing at all when the
 * page carries no metadata — Google omits the key rather than sending `{}`, and
 * so do we.
 */
export function parsePagemap(html: string, pageUrl: string): PageMap | undefined {
  const head = headOf(html);
  const visible = stripComments(head);

  const map: PageMap = {};
  const metatags = metatagsFrom(visible);
  if (metatags !== undefined) map['metatags'] = [metatags];
  addJsonLd(visible, map);
  addMicrodata(visible, map);
  addLiteralPageMap(head, map);

  // `cse_image` and `cse_thumbnail` are the two keys migrating clients read
  // most. Google's thumbnail is its own cropped copy; ours is the page's image,
  // so the `src` is honest and the crop dimensions Google reports are omitted
  // rather than fabricated.
  const image = IMAGE_META_KEYS.map((key) => absoluteUrl(metatags?.[key], pageUrl)).find(
    (src) => src !== undefined,
  );
  if (image !== undefined) {
    map['cse_image'] = [{ src: image }];
    map['cse_thumbnail'] = [{ src: image }];
  }

  return Object.keys(map).length > 0 ? map : undefined;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** The shape `PagemapClient` needs from a mapped item. `CseItem` satisfies it. */
export interface Enrichable {
  link: string;
  image?: { contextLink: string } | undefined;
  pagemap?: PageMap | undefined;
}

export interface PagemapClientOptions {
  /** Distinct result pages fetched per request. 0 disables fetching entirely. */
  maxUrls: number;
  /** Per-URL deadline, covering redirects and the body read. */
  timeoutMs: number;
  /** Deadline for the whole enrichment pass, so one slow page cannot stall. */
  budgetMs: number;
  /** Lifetime of a cached page, ms. 0 disables the cache. */
  ttlMs: number;
  /** Maximum number of URLs held in the cache. */
  cacheMax: number;
  /** Allow fetching loopback/private-network hosts. Off by default. */
  allowPrivateHosts?: boolean;
  concurrency?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  /** null means "fetched or attempted, nothing to attach" — cached too. */
  map: PageMap | null;
  expiresAt: number;
}

/**
 * Hosts we refuse by default.
 *
 * Result URLs come from whatever SearXNG's engines returned, so enabling
 * pagemap turns the bridge into something that will fetch a URL a third party
 * chose. Refusing literal loopback and RFC1918 addresses keeps the obvious
 * "point it at 169.254.169.254" case out. It is NOT rebinding-proof: we match
 * on the hostname and do not resolve names, which is why it is documented
 * rather than presented as a sandbox.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  // Only a host containing a colon can be an IPv6 literal. Testing the prefix
  // against a plain name would refuse fdic.gov for looking like fd00::/8.
  if (host.includes(':')) return isPrivateIpv6(host);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}


/**
 * Loopback, unique-local (fc00::/7), link- and site-local (fe80::/10,
 * fec0::/10), and the IPv4-mapped range. Node normalizes `[::ffff:127.0.0.1]`
 * to `::ffff:7f00:1`, so the mapped form is read back out as hextets.
 */
function isPrivateIpv6(host: string): boolean {
  if (host === '::1' || host === '::') return true;
  const first = host.split(':')[0] ?? '';
  if (/^f[cd]/.test(first) || /^fe[89a-f]/.test(first)) return true;

  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped === null) return false;
  const rest = mapped[1]!;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPrivateHost(rest);
  const hextets = rest.split(':');
  if (hextets.length !== 2 || !hextets.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return false;
  const [high, low] = hextets.map((h) => Number.parseInt(h, 16)) as [number, number];
  return isPrivateHost([high >> 8, high & 255, low >> 8, low & 255].join('.'));
}

/** Charset named by a Content-Type header, if it names one. */
function charsetOf(contentType: string): string | undefined {
  const m = /;\s*charset\s*=\s*"?([a-z0-9_.:-]+)"?/i.exec(contentType);
  return m === null ? undefined : m[1]!;
}

/** Charset the document declares: `<meta charset>` or the http-equiv form. */
function declaredCharset(head: string): string | undefined {
  for (const meta of head.matchAll(META_RE)) {
    const attrs = attributesOf(meta[1]!);
    const direct = attrs['charset'];
    if (direct !== undefined) return direct.trim();
    if (attrs['http-equiv']?.toLowerCase() === 'content-type') {
      const inner = charsetOf(attrs['content'] ?? '');
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

/** A decoder for a charset name, or nothing when the label is unknown. */
function decoderFor(charset: string | undefined): InstanceType<typeof TextDecoder> | undefined {
  if (charset === undefined) return undefined;
  try {
    return new TextDecoder(charset);
  } catch {
    return undefined;
  }
}

/** Everything up to and including `</head>`, or the whole string. */
function cutAtHeadEnd(text: string): string {
  const end = /<\/head\s*>/i.exec(text);
  return end === null ? text : text.slice(0, end.index + end[0].length);
}

/**
 * Read a response body until `</head>`, the 512 KB cap, or the end — whichever
 * comes first. Stopping at `</head>` is what keeps this cheap on a 3 MB page.
 *
 * When the server names no charset, the bytes are kept so a `<meta charset>`
 * the page declares can be honoured with a second decode. Plenty of pages still
 * serve windows-1252 with a bare `text/html`.
 */
async function readHead(res: Response, contentType: string): Promise<string> {
  // An unusable label in the header counts as no header charset, so a page
  // that declares something sane in its head can still be read.
  const headerDecoder = decoderFor(charsetOf(contentType));
  const decoder = headerDecoder ?? new TextDecoder('utf-8');

  const body = res.body;
  if (body === null) return cutAtHeadEnd((await res.text()).slice(0, MAX_BODY_BYTES));

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      bytes += value.byteLength;
      if (headerDecoder === undefined) chunks.push(value);
      text += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(text)) break;
      if (bytes >= MAX_BODY_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const head = cutAtHeadEnd(text);
  if (headerDecoder !== undefined) return head;

  // The declaration is read from the utf-8 pass, which is fine: every encoding
  // a page declares this way is ASCII-compatible, so the meta tag itself
  // survives being decoded as utf-8.
  const declared = decoderFor(declaredCharset(head));
  if (declared === undefined || declared.encoding === 'utf-8') return head;
  const joined = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return cutAtHeadEnd(declared.decode(joined));
}

export class PagemapClient {
  private readonly maxUrls: number;
  private readonly timeoutMs: number;
  private readonly budgetMs: number;
  private readonly ttlMs: number;
  private readonly cacheMax: number;
  private readonly allowPrivateHosts: boolean;
  private readonly concurrency: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: PagemapClientOptions) {
    this.maxUrls = opts.maxUrls;
    this.timeoutMs = opts.timeoutMs;
    this.budgetMs = opts.budgetMs;
    this.ttlMs = opts.ttlMs;
    this.cacheMax = opts.cacheMax;
    this.allowPrivateHosts = opts.allowPrivateHosts ?? false;
    this.concurrency = opts.concurrency ?? PAGEMAP_CONCURRENCY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Number of pages held in the cache. Surfaced on /healthz. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Attach a pagemap to as many items as the budget allows, in place.
   *
   * Never throws and never rejects: a page that times out, 404s or serves a
   * PDF simply leaves its item exactly as the mapper built it. Running out of
   * budget does the same for every item not reached yet.
   */
  async enrich(items: Enrichable[]): Promise<void> {
    if (this.maxUrls <= 0 || items.length === 0) return;

    // Several results can share a page: every image in one gallery carries the
    // same `image.contextLink`. Group by URL so that costs one fetch, and so
    // the cap counts pages rather than items.
    const targets = new Map<string, Enrichable[]>();
    for (const item of items) {
      const url = this.targetUrl(item);
      if (url === undefined) continue;
      const sharing = targets.get(url);
      if (sharing !== undefined) {
        sharing.push(item);
      } else if (targets.size < this.maxUrls) {
        targets.set(url, [item]);
      }
    }
    if (targets.size === 0) return;

    const queue = [...targets];
    const budget = new AbortController();
    const expiry = setTimeout(() => budget.abort(), this.budgetMs);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length && !budget.signal.aborted) {
        const [url, sharing] = queue[next++]!;
        try {
          const map = await this.lookup(url, budget.signal);
          if (map !== null) for (const item of sharing) item.pagemap = map;
        } catch {
          // lookup swallows fetch failures itself; this is the backstop that
          // keeps the promise above of never rejecting.
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    } finally {
      clearTimeout(expiry);
    }
  }

  /**
   * The page to read for an item. For an image result `link` is the image file
   * itself, so the metadata lives on `image.contextLink` — and we never spend
   * the budget downloading a JPEG.
   */
  private targetUrl(item: Enrichable): string | undefined {
    const raw = item.image?.contextLink ?? item.link;
    if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return undefined;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!this.allowPrivateHosts && isPrivateHost(url.hostname)) return undefined;
    // The fragment never reaches the server, so `#install` and `#usage` are one
    // fetch and one cache entry.
    url.hash = '';
    return url.toString();
  }

  private async lookup(url: string, budget: AbortSignal): Promise<PageMap | null> {
    const now = Date.now();
    if (this.ttlMs > 0) {
      const hit = this.cache.get(url);
      if (hit !== undefined && hit.expiresAt > now) {
        // Re-insert to move it to the young end: Map iterates insertion order,
        // which is what makes the eviction below least-recently-used.
        this.cache.delete(url);
        this.cache.set(url, hit);
        return hit.map;
      }
      if (hit !== undefined) this.cache.delete(url);
    }

    const html = await this.fetchHead(url, budget);
    const map = html === null ? null : (parsePagemap(html, url) ?? null);
    if (this.ttlMs > 0) {
      // Failures are cached too, so a dead link is not refetched on every page
      // of results.
      this.cache.set(url, { map, expiresAt: now + this.ttlMs });
      trim(this.cache, now, this.cacheMax);
    }
    return map;
  }

  /** The head of one page, or null for any reason at all. Never throws. */
  private async fetchHead(url: string, budget: AbortSignal): Promise<string | null> {
    const perUrl = new AbortController();
    const timer = setTimeout(() => perUrl.abort(), this.timeoutMs);
    const signal = AbortSignal.any([perUrl.signal, budget]);
    let current = url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await this.fetchImpl(current, {
          redirect: 'manual',
          headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
          signal,
        });

        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          if (hop === MAX_REDIRECTS) return null;
          const location = res.headers.get('location');
          if (location === null) return null;
          const next = this.targetUrl({ link: new URL(location, current).toString() });
          if (next === undefined) return null;
          current = next;
          continue;
        }

        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType !== '' && !HTML_CONTENT_TYPE.test(contentType)) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        return await readHead(res, contentType);
      }
      return null;
    } catch {
      // Timeouts, DNS failures, TLS errors, a body that dies mid-stream: all of
      // them mean "no pagemap for this item", never a failed search response.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
