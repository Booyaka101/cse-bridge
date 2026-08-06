/**
 * SearXNG results -> Google `customsearch#search` resource.
 *
 * The four things a naive mapper gets wrong, all of which clients depend on:
 *
 *  1. totalResults. SearXNG's JSON has no count field at all. Multiplying the
 *     page length by 100 invents a number; clients that loop "while start <
 *     totalResults" then request pages that do not exist. We report a LOWER
 *     BOUND: everything we have actually seen, plus one more page's worth only
 *     when a next page genuinely exists.
 *  2. queries.nextPage / previousPage. Clients page by reading nextPage[0]
 *     .startIndex rather than doing arithmetic. Omitting them silently caps
 *     every consumer at one page.
 *  3. htmlTitle / htmlSnippet / htmlFormattedUrl are HTML. Copying the plain
 *     text through unescaped injects any `<`, `&` or `"` in a result title
 *     straight into whatever renders it.
 *  4. `items` must be ABSENT (not `[]`) on zero results, because that is what
 *     Google does and `if 'items' in response` is the idiomatic check.
 */

import type { CseParams } from './params.ts';
import type { SearxngResult } from './searxng.ts';
import { MAX_START } from './params.ts';

export interface CseItem {
  kind: 'customsearch#result';
  title: string;
  htmlTitle: string;
  link: string;
  displayLink: string;
  snippet: string;
  htmlSnippet: string;
  formattedUrl: string;
  htmlFormattedUrl: string;
  /** Image results only (`searchType=image`). */
  mime?: string;
  fileFormat?: string;
  image?: CseImage;
}

/**
 * Google's Result.image object. `thumbnailWidth`/`thumbnailHeight` exist in
 * the schema but SearXNG does not report thumbnail dimensions, so we OMIT them
 * rather than synthesize a number — the same posture as `totalResults`.
 */
export interface CseImage {
  contextLink: string;
  thumbnailLink?: string;
  thumbnailHeight?: number;
  thumbnailWidth?: number;
  height?: number;
  width?: number;
  byteSize?: number;
}

export interface CseQueryRequest {
  title: string;
  totalResults: string;
  searchTerms: string;
  count: number;
  startIndex: number;
  inputEncoding: string;
  outputEncoding: string;
  safe: string;
  cx: string;
  /** Present only when the request specified `searchType=image`, as Google does. */
  searchType?: string;
}

export interface CseSearchResponse {
  kind: 'customsearch#search';
  url: { type: string; template: string };
  queries: {
    request: CseQueryRequest[];
    nextPage?: CseQueryRequest[];
    previousPage?: CseQueryRequest[];
  };
  searchInformation: {
    searchTime: number;
    formattedSearchTime: string;
    totalResults: string;
    formattedTotalResults: string;
  };
  spelling?: { correctedQuery: string; htmlCorrectedQuery: string };
  items?: CseItem[];
}

export const URL_TEMPLATE =
  'https://www.googleapis.com/customsearch/v1?q={searchTerms}&num={count?}&start={startIndex?}&cx={cx?}';

/** Escape text for interpolation into an HTML document. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Google renders totalResults with thousands separators. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** Google renders searchTime with two decimal places. */
export function formatSearchTime(seconds: number): string {
  return seconds.toFixed(2);
}

/**
 * `displayLink` is the bare host: no scheme, no path, no port, no trailing dot.
 * Google also drops a leading "www." — it is the label a user sees.
 */
export function toDisplayLink(link: string): string {
  try {
    const host = new URL(link).hostname;
    return host.replace(/\.$/, '');
  } catch {
    // Not parseable as a URL: strip anything that looks like a scheme/path so
    // we still never emit a scheme, which is what the field promises.
    return link.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? link;
  }
}

/**
 * Google percent-decodes and elides long URLs in `formattedUrl`. We decode what
 * is safely decodable and leave the rest, which keeps the field human-readable
 * without inventing an ellipsis that would break copy-paste.
 */
export function toFormattedUrl(link: string): string {
  try {
    return decodeURI(link);
  } catch {
    return link;
  }
}

export function mapItem(result: SearxngResult): CseItem | null {
  const link = typeof result.url === 'string' ? result.url.trim() : '';
  if (link.length === 0) return null;

  const title = (typeof result.title === 'string' && result.title.trim().length > 0
    ? result.title.trim()
    : toDisplayLink(link));
  const snippet = typeof result.content === 'string' && result.content.trim().length > 0
    ? result.content.trim()
    : title;
  const formattedUrl = toFormattedUrl(link);

  return {
    kind: 'customsearch#result',
    title,
    htmlTitle: escapeHtml(title),
    link,
    displayLink: toDisplayLink(link),
    snippet,
    htmlSnippet: escapeHtml(snippet),
    formattedUrl,
    htmlFormattedUrl: escapeHtml(formattedUrl),
  };
}

/**
 * `resolution` is a human-readable string like `"1920 x 1080"` (SearXNG's own
 * documented example). Tolerate spacing variations and the unicode ×; anything
 * that does not match yields NOTHING — a guessed dimension is worse than an
 * omitted one.
 */
export function parseResolution(resolution: unknown): { width: number; height: number } | undefined {
  if (typeof resolution !== 'string') return undefined;
  const m = /(\d+)\s*[x×]\s*(\d+)/.exec(resolution);
  if (!m) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * `filesize` is human-readable — SearXNG documents `"1MB"` for 1024*1024
 * bytes, engines emit variants like `"412 KB"` or `"1.2 MB"`. 1 KB = 1024.
 * Unparseable (e.g. `"huge"`) yields NOTHING, never a guess.
 */
export function parseFilesize(filesize: unknown): number | undefined {
  if (typeof filesize !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmg]i?b|b)\s*$/i.exec(filesize);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = m[2]!.toLowerCase().charAt(0);
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  return Math.round(value * factor);
}

/**
 * SearXNG's `img_format` is a bare token like `"jpg"` or `"png"`. Normalise it
 * to the canonical MIME subtype (jpg -> jpeg) so `mime` is a real MIME type.
 * A token that does not look like a format at all yields nothing.
 */
function normalizeImgFormat(imgFormat: unknown): string | undefined {
  if (typeof imgFormat !== 'string') return undefined;
  let token = imgFormat.trim().toLowerCase();
  if (token.startsWith('image/')) token = token.slice('image/'.length);
  if (token === 'jpg') token = 'jpeg';
  if (!/^[a-z0-9][a-z0-9.+-]*$/.test(token)) return undefined;
  return token;
}

/**
 * An image result's `link` is the IMAGE (`img_src`), and the page it sits on
 * becomes `image.contextLink` — that is Google's contract, and clients hotlink
 * `link` into <img> tags. A result with no img_src is dropped entirely:
 * emitting an item whose `link` points at an HTML page would break every one
 * of those clients silently.
 */
export function mapImageItem(result: SearxngResult): CseItem | null {
  const link = typeof result.img_src === 'string' ? result.img_src.trim() : '';
  if (link.length === 0) return null;
  const contextLink = typeof result.url === 'string' ? result.url.trim() : '';
  if (contextLink.length === 0) return null;

  const title = (typeof result.title === 'string' && result.title.trim().length > 0
    ? result.title.trim()
    : toDisplayLink(link));
  const snippet = typeof result.content === 'string' && result.content.trim().length > 0
    ? result.content.trim()
    : title;
  const formattedUrl = toFormattedUrl(link);

  const image: CseImage = { contextLink };
  if (typeof result.thumbnail_src === 'string' && result.thumbnail_src.trim().length > 0) {
    image.thumbnailLink = result.thumbnail_src.trim();
  }
  const dims = parseResolution(result.resolution);
  if (dims) {
    image.width = dims.width;
    image.height = dims.height;
  }
  const byteSize = parseFilesize(result.filesize);
  if (byteSize !== undefined) image.byteSize = byteSize;

  const format = normalizeImgFormat(result.img_format);

  return {
    kind: 'customsearch#result',
    title,
    htmlTitle: escapeHtml(title),
    link,
    displayLink: toDisplayLink(link),
    snippet,
    htmlSnippet: escapeHtml(snippet),
    ...(format !== undefined ? { mime: `image/${format}`, fileFormat: `image/${format}` } : {}),
    formattedUrl,
    htmlFormattedUrl: escapeHtml(formattedUrl),
    image,
  };
}

function requestBlock(opts: {
  params: CseParams;
  totalResults: string;
  count: number;
  startIndex: number;
}): CseQueryRequest {
  const block: CseQueryRequest = {
    title: `Google Custom Search - ${opts.params.q}`,
    totalResults: opts.totalResults,
    searchTerms: opts.params.q,
    count: opts.count,
    startIndex: opts.startIndex,
    inputEncoding: 'utf8',
    outputEncoding: 'utf8',
    safe: opts.params.safe,
    cx: opts.params.cx,
  };
  // Google round-trips searchType in queries.request when it was specified.
  if (opts.params.searchType !== undefined) block.searchType = opts.params.searchType;
  return block;
}

/**
 * Lower-bound total. Everything we have actually walked past, plus one more
 * page's worth when a next page exists so that `start < totalResults` loops
 * keep advancing. Never 0 while items exist.
 */
export function synthesizeTotal(start: number, itemCount: number, hasNextPage: boolean, nextCount: number): number {
  // No items on this page => report 0, exactly as Google does for an empty
  // result set. This also covers a `start` past the end of the backend's
  // results: claiming `start-1` hits we cannot show would keep a paging client
  // looping forever against pages that will never contain anything.
  if (itemCount === 0) return 0;
  const seen = start - 1 + itemCount;
  return hasNextPage ? seen + nextCount : seen;
}

export interface MapInput {
  params: CseParams;
  /** The already-sliced window of backend results for this page. */
  results: SearxngResult[];
  /** Whether the backend has at least one result beyond this window. */
  hasMore: boolean;
  /** Wall-clock seconds spent talking to the backend. */
  searchTime: number;
  /** SearXNG `corrections`, surfaced as Google's `spelling`. */
  corrections?: unknown[];
}

/** Build the full customsearch#search response body. */
export function mapResponse(input: MapInput): CseSearchResponse {
  const { params, results, hasMore, searchTime } = input;

  const toItem = params.searchType === 'image' ? mapImageItem : mapItem;
  const items = results.map(toItem).filter((i): i is CseItem => i !== null);
  const count = items.length;

  // A next page is only offered when this page is FULL and more exists, and
  // only when its startIndex is actually requestable (Google caps start at 91).
  const nextStartIndex = params.start + count;
  const hasNextPage = hasMore && count === params.num && nextStartIndex <= MAX_START;

  const total = synthesizeTotal(params.start, count, hasNextPage, params.num);
  const totalResults = String(total);

  const response: CseSearchResponse = {
    kind: 'customsearch#search',
    url: { type: 'application/json', template: URL_TEMPLATE },
    queries: {
      request: [requestBlock({ params, totalResults, count, startIndex: params.start })],
    },
    searchInformation: {
      searchTime,
      formattedSearchTime: formatSearchTime(searchTime),
      totalResults,
      formattedTotalResults: formatNumber(total),
    },
  };

  if (hasNextPage) {
    response.queries.nextPage = [
      requestBlock({ params, totalResults, count: params.num, startIndex: nextStartIndex }),
    ];
  }

  if (params.start > 1) {
    const prevStartIndex = Math.max(1, params.start - params.num);
    response.queries.previousPage = [
      requestBlock({ params, totalResults, count: params.num, startIndex: prevStartIndex }),
    ];
  }

  const correction = firstCorrection(input.corrections);
  if (correction !== undefined) {
    response.spelling = { correctedQuery: correction, htmlCorrectedQuery: escapeHtml(correction) };
  }

  // Google omits `items` entirely when there are no results.
  if (count > 0) response.items = items;

  return response;
}

function firstCorrection(corrections: unknown[] | undefined): string | undefined {
  if (!Array.isArray(corrections)) return undefined;
  for (const c of corrections) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
    if (c !== null && typeof c === 'object') {
      const q = (c as Record<string, unknown>)['query'] ?? (c as Record<string, unknown>)['url'];
      if (typeof q === 'string' && q.trim().length > 0) return q.trim();
    }
  }
  return undefined;
}

/**
 * `sort=date` (and `sort=date:d`, Google's descending form) reorders by the
 * publishedDate SearXNG attaches to news/paper results. Results without a date
 * keep their relevance order and sit after the dated ones, which is the least
 * surprising behaviour for a mixed result set.
 */
export function applySort(results: SearxngResult[], sort: string | undefined): SearxngResult[] {
  if (!sort || !/^date\b/i.test(sort)) return results;
  const ascending = /:a\b/i.test(sort);
  const dated: { r: SearxngResult; t: number }[] = [];
  const undatedResults: SearxngResult[] = [];
  for (const r of results) {
    const t = r.publishedDate ? Date.parse(r.publishedDate) : Number.NaN;
    if (Number.isNaN(t)) undatedResults.push(r);
    else dated.push({ r, t });
  }
  dated.sort((a, b) => (ascending ? a.t - b.t : b.t - a.t));
  return [...dated.map((d) => d.r), ...undatedResults];
}
