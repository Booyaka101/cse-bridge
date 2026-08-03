/**
 * Parse and validate the Custom Search JSON API query parameters.
 *
 * The rules here mirror Google's documented limits, because a client that
 * survived against Google must keep seeing the same acceptance envelope:
 *   - num is 1..10; values above 10 CLAMP (Google errors, but clamping is
 *     strictly friendlier and keeps `start=1,11,21` loops walking correctly)
 *   - start is 1..91 (Google caps the result set at 100)
 *   - safe is off|active (plus the legacy medium|high aliases)
 *   - dateRestrict is [dwmy]N
 *   - siteSearchFilter is i|e
 */

import { invalidArgument } from './errors.ts';

export const MAX_NUM = 10;
export const MAX_START = 91;

export type SafeLevel = 'off' | 'active' | 'high' | 'medium';

export interface CseParams {
  key: string | undefined;
  cx: string;
  q: string;
  num: number;
  start: number;
  hl: string | undefined;
  lr: string | undefined;
  safe: SafeLevel;
  siteSearch: string | undefined;
  siteSearchFilter: 'i' | 'e' | undefined;
  dateRestrict: string | undefined;
  fileType: string | undefined;
  exactTerms: string | undefined;
  excludeTerms: string | undefined;
  sort: string | undefined;
}

const SAFE_VALUES: readonly SafeLevel[] = ['off', 'active', 'high', 'medium'];

/** SearXNG's `safesearch` scale: 0 none, 1 moderate, 2 strict. */
export function safeToSearxng(safe: SafeLevel): 0 | 1 | 2 {
  switch (safe) {
    case 'off':
      return 0;
    case 'medium':
      return 1;
    case 'active':
    case 'high':
      return 2;
  }
}

/**
 * Google's `dateRestrict` ([dwmy]N) onto SearXNG's `time_range`.
 * SearXNG only offers day/week/month/year buckets, so N is rounded UP to the
 * smallest bucket that contains it — a superset, never a subset, of what the
 * caller asked for. `null` means "wider than a year: do not restrict".
 */
export function dateRestrictToTimeRange(dateRestrict: string): 'day' | 'week' | 'month' | 'year' | null {
  const m = /^([dwmy])(\d+)$/.exec(dateRestrict);
  if (!m) return null;
  const unit = m[1] as 'd' | 'w' | 'm' | 'y';
  const n = Number(m[2]);
  const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365;
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  if (days <= 366) return 'year';
  return null;
}

/** Google's `lr` (`lang_de`) or `hl` (`de`) onto SearXNG's `language`. */
export function languageFor(lr: string | undefined, hl: string | undefined): string | undefined {
  if (lr) {
    const stripped = lr.startsWith('lang_') ? lr.slice('lang_'.length) : lr;
    if (stripped) return stripped;
  }
  return hl && hl.length > 0 ? hl : undefined;
}

function single(searchParams: URLSearchParams, name: string): string | undefined {
  const v = searchParams.get(name);
  if (v === null) return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function integer(searchParams: URLSearchParams, name: string, fallback: number): number {
  const raw = single(searchParams, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw invalidArgument(`Invalid value for parameter '${name}': ${raw}. Expected an integer.`, name);
  }
  return Number(raw);
}

/**
 * Parse a querystring into validated CSE params.
 * Throws an {@link ApiError} carrying Google's exact envelope on bad input.
 */
export function parseParams(searchParams: URLSearchParams): CseParams {
  const q = single(searchParams, 'q');
  if (q === undefined) {
    throw invalidArgument("Missing required parameter: 'q'.", 'q');
  }

  const cx = single(searchParams, 'cx');
  if (cx === undefined) {
    throw invalidArgument("Missing required parameter: 'cx'.", 'cx');
  }

  // num: clamp above the ceiling, reject below the floor.
  const rawNum = integer(searchParams, 'num', MAX_NUM);
  if (rawNum < 1) {
    throw invalidArgument(`Invalid value for parameter 'num': ${rawNum}. Expected a value between 1 and ${MAX_NUM}.`, 'num');
  }
  const num = Math.min(rawNum, MAX_NUM);

  const start = integer(searchParams, 'start', 1);
  if (start < 1 || start > MAX_START) {
    throw invalidArgument(
      `Invalid value for parameter 'start': ${start}. Expected a value between 1 and ${MAX_START}.`,
      'start',
    );
  }

  const rawSafe = single(searchParams, 'safe') ?? 'off';
  if (!SAFE_VALUES.includes(rawSafe as SafeLevel)) {
    throw invalidArgument(
      `Invalid value for parameter 'safe': ${rawSafe}. Expected one of: ${SAFE_VALUES.join(', ')}.`,
      'safe',
    );
  }
  const safe = rawSafe as SafeLevel;

  const dateRestrict = single(searchParams, 'dateRestrict');
  if (dateRestrict !== undefined && !/^[dwmy]\d+$/.test(dateRestrict)) {
    throw invalidArgument(
      `Invalid value for parameter 'dateRestrict': ${dateRestrict}. Expected d[number], w[number], m[number] or y[number].`,
      'dateRestrict',
    );
  }

  const rawFilter = single(searchParams, 'siteSearchFilter');
  if (rawFilter !== undefined && rawFilter !== 'i' && rawFilter !== 'e') {
    throw invalidArgument(
      `Invalid value for parameter 'siteSearchFilter': ${rawFilter}. Expected 'i' (include) or 'e' (exclude).`,
      'siteSearchFilter',
    );
  }

  const sort = single(searchParams, 'sort');
  if (sort !== undefined && !/^[a-zA-Z0-9_.:,=\-]+$/.test(sort)) {
    throw invalidArgument(`Invalid value for parameter 'sort': ${sort}.`, 'sort');
  }

  return {
    key: single(searchParams, 'key'),
    cx,
    q,
    num,
    start,
    hl: single(searchParams, 'hl'),
    lr: single(searchParams, 'lr'),
    safe,
    siteSearch: single(searchParams, 'siteSearch'),
    siteSearchFilter: rawFilter as 'i' | 'e' | undefined,
    dateRestrict,
    fileType: single(searchParams, 'fileType'),
    exactTerms: single(searchParams, 'exactTerms'),
    excludeTerms: single(searchParams, 'excludeTerms'),
    sort,
  };
}

/**
 * Fold the operator-ish CSE params (siteSearch, fileType, exactTerms,
 * excludeTerms) plus the profile's site restriction into a single SearXNG
 * query string, since SearXNG has no dedicated parameters for them.
 */
export function buildQueryString(params: CseParams, profileSite: string | undefined): string {
  const parts: string[] = [params.q];

  const site = params.siteSearch ?? profileSite;
  if (site) {
    // An explicit siteSearch with filter 'e' excludes; everything else includes.
    const exclude = params.siteSearch !== undefined && params.siteSearchFilter === 'e';
    parts.push(`${exclude ? '-' : ''}site:${site}`);
  }

  if (params.fileType) parts.push(`filetype:${params.fileType}`);
  if (params.exactTerms) parts.push(`"${params.exactTerms.replace(/"/g, '')}"`);
  if (params.excludeTerms) {
    for (const term of params.excludeTerms.split(/\s+/).filter(Boolean)) {
      parts.push(`-${term}`);
    }
  }

  return parts.join(' ');
}

/**
 * Which SearXNG page holds the result at 1-based index `start`.
 * SearXNG pages are backend-sized (typically ~10-30 merged results), so we ask
 * for the page that contains `start` and slice locally — see fetchWindow().
 */
export function pageForStart(start: number, pageSize: number): number {
  return Math.floor((start - 1) / pageSize) + 1;
}
