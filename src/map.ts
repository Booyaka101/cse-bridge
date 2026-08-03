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

function requestBlock(opts: {
  params: CseParams;
  totalResults: string;
  count: number;
  startIndex: number;
}): CseQueryRequest {
  return {
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

  const items = results.map(mapItem).filter((i): i is CseItem => i !== null);
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
