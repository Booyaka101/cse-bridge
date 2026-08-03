/**
 * SearXNG backend client.
 *
 * The JSON payload SearXNG emits is defined by `get_json_response` in
 * searx/webutils.py and is exactly:
 *
 *   {query, results, answers, corrections, infoboxes, suggestions,
 *    unresponsive_engines}
 *
 * Note what is NOT there: any total/estimated result count. Anything a bridge
 * reports as `totalResults` is therefore synthesized, and the honest synthesis
 * is a lower bound (see map.ts). Reading a `number_of_results` key off this
 * payload yields `undefined` and, with a naive fallback, a fabricated number.
 */

import { backendUnavailable, rateLimited } from './errors.ts';

export interface SearxngResult {
  url: string;
  title?: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string | null;
  score?: number;
  category?: string;
  [key: string]: unknown;
}

export interface SearxngResponse {
  query: string;
  results: SearxngResult[];
  answers: unknown[];
  corrections: unknown[];
  infoboxes: unknown[];
  suggestions: unknown[];
  unresponsive_engines: unknown[];
}

export interface SearchOptions {
  query: string;
  pageno: number;
  language?: string | undefined;
  safesearch: 0 | 1 | 2;
  timeRange?: 'day' | 'week' | 'month' | 'year' | null | undefined;
  engines?: string[];
  categories?: string[];
}

export interface SearxngClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Hard ceiling on backend pages fetched per bridge request. */
  maxPages?: number;
  /** Lifetime of a cached result set, ms. 0 disables the cache. */
  cacheTtlMs?: number;
  /** Maximum number of distinct queries held in the cache. */
  cacheMax?: number;
}

/** Highest number of SearXNG pages we will walk to satisfy one CSE request. */
export const DEFAULT_MAX_PAGES = 12;
export const DEFAULT_CACHE_TTL_MS = 300_000;
export const DEFAULT_CACHE_MAX = 256;

/**
 * One query's accumulated, de-duplicated result list.
 *
 * This is what makes `start=1`, `start=11` and `start=21` return DISJOINT
 * links against a live instance. SearXNG merges several engines per request
 * and their latencies vary, so two identical queries seconds apart come back
 * in a different order — page 2 then re-serves links page 1 already showed.
 * Google resolves a query to a stable result set and pages within it; so do we,
 * for as long as the cache entry lives.
 */
interface ResultSet {
  results: SearxngResult[];
  seen: Set<string>;
  /** Highest backend page already merged in. */
  pagesFetched: number;
  /** The backend stopped producing anything new. */
  exhausted: boolean;
  expiresAt: number;
}

export function buildSearchUrl(baseUrl: string, opts: SearchOptions): string {
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set('q', opts.query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageno', String(opts.pageno));
  url.searchParams.set('safesearch', String(opts.safesearch));
  if (opts.language) url.searchParams.set('language', opts.language);
  if (opts.timeRange) url.searchParams.set('time_range', opts.timeRange);
  if (opts.engines && opts.engines.length > 0) url.searchParams.set('engines', opts.engines.join(','));
  if (opts.categories && opts.categories.length > 0) url.searchParams.set('categories', opts.categories.join(','));
  return url.toString();
}

export class SearxngClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPages: number;
  private readonly cacheTtlMs: number;
  private readonly cacheMax: number;
  private readonly cache = new Map<string, ResultSet>();
  /** Per-query serialization of backend walks, keyed like the cache. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(opts: SearxngClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheMax = opts.cacheMax ?? DEFAULT_CACHE_MAX;
  }

  /**
   * Cheap liveness probe: is anything answering at SEARXNG_URL?
   *
   * Deliberately not a search — /healthz is polled every 30s by the container
   * healthcheck, and firing a real query at the upstream engines that often
   * would get the instance rate-limited for no diagnostic gain. Use
   * `/healthz?deep=1` when you want to prove JSON output is actually enabled.
   */
  async ping(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/`, {
        headers: { 'User-Agent': 'cse-bridge' },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw backendUnavailable(`SearXNG at ${this.baseUrl} did not respond in time.`);
      }
      throw backendUnavailable(`SearXNG at ${this.baseUrl} is unreachable: ${e.message}`);
    }
    if (res.status >= 500) {
      throw backendUnavailable(`SearXNG at ${this.baseUrl} returned HTTP ${res.status}.`);
    }
  }

  /** Fetch exactly one SearXNG page. Throws ApiError on any failure. */
  async searchPage(opts: SearchOptions): Promise<SearxngResponse> {
    const url = buildSearchUrl(this.baseUrl, opts);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'cse-bridge',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw backendUnavailable(`SearXNG at ${this.baseUrl} did not respond within ${this.timeoutMs}ms.`);
      }
      throw backendUnavailable(`SearXNG at ${this.baseUrl} is unreachable: ${e.message}`);
    }

    if (res.status === 429) {
      throw rateLimited(`SearXNG at ${this.baseUrl} is rate limiting this client (HTTP 429).`);
    }
    if (res.status === 403) {
      throw backendUnavailable(
        `SearXNG at ${this.baseUrl} refused the request (HTTP 403). Its limiter or botdetection is likely blocking this client.`,
      );
    }
    if (!res.ok) {
      throw backendUnavailable(`SearXNG at ${this.baseUrl} returned HTTP ${res.status}.`);
    }

    const body = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // The overwhelmingly common cause: `json` is missing from `search.formats`
      // in settings.yml, so SearXNG serves the HTML results page instead.
      const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(body);
      throw backendUnavailable(
        looksLikeHtml
          ? `SearXNG at ${this.baseUrl} returned HTML, not JSON. Enable it in settings.yml:\n  search:\n    formats:\n      - html\n      - json`
          : `SearXNG at ${this.baseUrl} returned a body that is not JSON.`,
      );
    }

    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as SearxngResponse).results)) {
      throw backendUnavailable(`SearXNG at ${this.baseUrl} returned JSON without a 'results' array.`);
    }
    return parsed as SearxngResponse;
  }

  /**
   * Collect a stable, de-duplicated result list long enough to cover the
   * 1-based window [start, start+num-1].
   *
   * We always walk from SearXNG page 1. That costs extra backend calls for deep
   * pages, but it is the only way `start=1`, `start=11` and `start=21` return
   * DISJOINT link sets: SearXNG merges several engines per page, so its page
   * boundaries do not line up with Google's 10-per-page windows, and paging
   * straight through would both overlap and skip.
   */
  async fetchWindow(
    opts: Omit<SearchOptions, 'pageno'>,
    start: number,
    num: number,
  ): Promise<{
    results: SearxngResult[];
    window: SearxngResult[];
    hasMore: boolean;
    pagesFetched: number;
    cached: boolean;
  }> {
    const needed = start - 1 + num;
    const key = cacheKey(opts);
    let pagesFetchedNow = 0;

    // Serialize the backend walk per query. Without this, a client firing
    // start=1/11/21 concurrently on a cold cache would have three requests each
    // build their own competing result set, and the pages could overlap again.
    const prior = this.chains.get(key);
    const run = async (): Promise<ResultSet> => {
      const now = Date.now();
      let set = this.cacheTtlMs > 0 ? this.cache.get(key) : undefined;
      if (set !== undefined && set.expiresAt <= now) {
        this.cache.delete(key);
        set = undefined;
      }
      if (set === undefined) {
        set = { results: [], seen: new Set(), pagesFetched: 0, exhausted: false, expiresAt: now + this.cacheTtlMs };
      }

      // Resume from wherever the cached set stopped; fetch only what is missing.
      while (!set.exhausted && set.results.length <= needed && set.pagesFetched < this.maxPages) {
        const page = set.pagesFetched + 1;
        const res = await this.searchPage({ ...opts, pageno: page });
        set.pagesFetched = page;
        pagesFetchedNow++;
        const before = set.results.length;
        for (const r of res.results) {
          if (typeof r?.url !== 'string' || r.url.length === 0) continue;
          const norm = normalizeUrl(r.url);
          if (set.seen.has(norm)) continue;
          set.seen.add(norm);
          set.results.push(r);
        }
        // Nothing new on this page: the backend has run dry, stop walking.
        if (set.results.length === before) {
          set.exhausted = true;
          break;
        }
      }

      if (this.cacheTtlMs > 0) {
        this.cache.set(key, set);
        this.evict(now);
      }
      return set;
    };

    // A failed predecessor must not fail us; we simply run once it settles.
    const mine = prior === undefined ? run() : prior.then(run, run);
    const settled = mine.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    let set: ResultSet;
    try {
      set = await mine;
    } finally {
      // Only the tail of the chain clears it, so the map cannot grow unbounded
      // while still letting a queued follower run after us.
      if (this.chains.get(key) === settled) this.chains.delete(key);
    }

    const window = set.results.slice(start - 1, start - 1 + num);
    // Strictly more results than the window ends at => a next page really exists.
    const hasMore = set.results.length > start - 1 + window.length;
    return {
      results: set.results,
      window,
      hasMore,
      pagesFetched: pagesFetchedNow,
      cached: pagesFetchedNow === 0,
    };
  }

  /** Drop expired entries, then the oldest entries, down to cacheMax. */
  private evict(now: number): void {
    for (const [k, v] of this.cache) {
      if (v.expiresAt <= now) this.cache.delete(k);
    }
    // Map iterates in insertion order, so the first key is the oldest.
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Number of cached result sets. Surfaced on /healthz. */
  get cacheSize(): number {
    return this.cache.size;
  }
}

/**
 * Cache identity of a query. Every field that changes what the backend returns
 * must be in here, or two different searches would share one result set.
 */
function cacheKey(opts: Omit<SearchOptions, 'pageno'>): string {
  return JSON.stringify([
    opts.query,
    opts.language ?? '',
    opts.safesearch,
    opts.timeRange ?? '',
    (opts.engines ?? []).join(','),
    (opts.categories ?? []).join(','),
  ]);
}

/** Dedupe key: ignore trailing slash and the fragment, keep everything else. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw;
  }
}
