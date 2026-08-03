import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_NUM,
  MAX_START,
  buildQueryString,
  dateRestrictToTimeRange,
  languageFor,
  pageForStart,
  parseParams,
  safeToSearxng,
  type CseParams,
} from '../src/params.ts';
import { ApiError } from '../src/errors.ts';

function parse(qs: string): CseParams {
  return parseParams(new URLSearchParams(qs));
}

function expectApiError(qs: string): ApiError {
  try {
    parse(qs);
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
    return err;
  }
  throw new Error(`expected ${qs} to throw`);
}

describe('required params', () => {
  test('missing q is rejected with Google\'s envelope', () => {
    const err = expectApiError('cx=default');
    assert.equal(err.code, 400);
    assert.equal(err.status, 'INVALID_ARGUMENT');
    assert.equal(err.message, 'Request contains an invalid argument.');
    assert.equal(err.toEnvelope().error.errors[0]?.reason, 'badRequest');
    assert.match(err.detail, /'q'/);
  });

  test('missing cx is rejected', () => {
    const err = expectApiError('q=hello');
    assert.equal(err.code, 400);
    assert.match(err.detail, /'cx'/);
  });

  test('whitespace-only q counts as missing', () => {
    const err = expectApiError('q=%20%20&cx=default');
    assert.match(err.detail, /'q'/);
  });

  test('minimal valid request gets Google\'s defaults', () => {
    const p = parse('q=hello&cx=default');
    assert.equal(p.q, 'hello');
    assert.equal(p.cx, 'default');
    assert.equal(p.num, MAX_NUM);
    assert.equal(p.start, 1);
    assert.equal(p.safe, 'off');
    assert.equal(p.key, undefined);
  });
});

describe('num', () => {
  // The single most important compatibility rule: a client asking for 20 must
  // get a valid page of 10, not an error, or its paging loop dies.
  test('num above 10 clamps to 10 instead of erroring', () => {
    assert.equal(parse('q=a&cx=c&num=20').num, 10);
    assert.equal(parse('q=a&cx=c&num=100').num, 10);
  });

  test('num inside the range is preserved', () => {
    assert.equal(parse('q=a&cx=c&num=3').num, 3);
    assert.equal(parse('q=a&cx=c&num=1').num, 1);
    assert.equal(parse('q=a&cx=c&num=10').num, 10);
  });

  test('num below 1 is rejected', () => {
    const err = expectApiError('q=a&cx=c&num=0');
    assert.equal(err.code, 400);
    assert.match(err.detail, /'num'/);
    assert.equal(expectApiError('q=a&cx=c&num=-5').code, 400);
  });

  test('non-integer num is rejected, not silently coerced', () => {
    assert.match(expectApiError('q=a&cx=c&num=abc').detail, /Expected an integer/);
    assert.match(expectApiError('q=a&cx=c&num=3.5').detail, /Expected an integer/);
    // tp-custom-search-api's prototype does no validation at all here.
  });
});

describe('start', () => {
  test('start above 91 returns the exact Google error envelope', () => {
    const err = expectApiError('q=a&cx=c&start=92');
    const envelope = err.toEnvelope();
    assert.equal(envelope.error.code, 400);
    assert.equal(envelope.error.message, 'Request contains an invalid argument.');
    assert.equal(envelope.error.status, 'INVALID_ARGUMENT');
    assert.equal(envelope.error.errors.length, 1);
    assert.equal(envelope.error.errors[0]?.domain, 'global');
    assert.equal(envelope.error.errors[0]?.reason, 'badRequest');
    assert.ok((envelope.error.errors[0]?.message ?? '').length > 0);
  });

  test('start 91 is the last accepted page', () => {
    assert.equal(parse('q=a&cx=c&start=91').start, MAX_START);
    assert.equal(expectApiError('q=a&cx=c&start=101').code, 400);
  });

  test('start below 1 is rejected', () => {
    assert.equal(expectApiError('q=a&cx=c&start=0').code, 400);
  });

  test('the classic 1/11/21 loop is accepted', () => {
    for (const s of [1, 11, 21, 31, 41, 51, 61, 71, 81, 91]) {
      assert.equal(parse(`q=a&cx=c&start=${s}`).start, s);
    }
  });
});

describe('safe', () => {
  test('accepts Google\'s values and the legacy aliases', () => {
    assert.equal(parse('q=a&cx=c&safe=off').safe, 'off');
    assert.equal(parse('q=a&cx=c&safe=active').safe, 'active');
    assert.equal(parse('q=a&cx=c&safe=high').safe, 'high');
    assert.equal(parse('q=a&cx=c&safe=medium').safe, 'medium');
  });

  test('rejects anything else', () => {
    assert.match(expectApiError('q=a&cx=c&safe=yes').detail, /'safe'/);
  });

  test('maps onto SearXNG\'s 0/1/2 scale', () => {
    assert.equal(safeToSearxng('off'), 0);
    assert.equal(safeToSearxng('medium'), 1);
    assert.equal(safeToSearxng('active'), 2);
    assert.equal(safeToSearxng('high'), 2);
  });
});

describe('dateRestrict', () => {
  test('accepts d/w/m/y forms', () => {
    for (const v of ['d1', 'w2', 'm6', 'y1', 'd30']) {
      assert.equal(parse(`q=a&cx=c&dateRestrict=${v}`).dateRestrict, v);
    }
  });

  test('rejects malformed values', () => {
    assert.match(expectApiError('q=a&cx=c&dateRestrict=x9').detail, /dateRestrict/);
    assert.match(expectApiError('q=a&cx=c&dateRestrict=7d').detail, /dateRestrict/);
  });

  test('maps onto SearXNG time_range buckets, rounding up', () => {
    assert.equal(dateRestrictToTimeRange('d1'), 'day');
    assert.equal(dateRestrictToTimeRange('d3'), 'week');
    assert.equal(dateRestrictToTimeRange('w1'), 'week');
    assert.equal(dateRestrictToTimeRange('w3'), 'month');
    assert.equal(dateRestrictToTimeRange('m1'), 'month');
    assert.equal(dateRestrictToTimeRange('m6'), 'year');
    assert.equal(dateRestrictToTimeRange('y1'), 'year');
    // Wider than SearXNG's widest bucket: do not restrict at all.
    assert.equal(dateRestrictToTimeRange('y5'), null);
  });
});

describe('language', () => {
  test('lr wins over hl and loses its lang_ prefix', () => {
    assert.equal(languageFor('lang_de', 'en'), 'de');
    assert.equal(languageFor('lang_fr', undefined), 'fr');
  });

  test('hl is used when lr is absent', () => {
    assert.equal(languageFor(undefined, 'es'), 'es');
    assert.equal(languageFor('', 'es'), 'es');
  });

  test('neither yields undefined so the instance default applies', () => {
    assert.equal(languageFor(undefined, undefined), undefined);
  });
});

describe('siteSearchFilter and sort', () => {
  test('siteSearchFilter accepts only i and e', () => {
    assert.equal(parse('q=a&cx=c&siteSearch=x.com&siteSearchFilter=i').siteSearchFilter, 'i');
    assert.equal(parse('q=a&cx=c&siteSearch=x.com&siteSearchFilter=e').siteSearchFilter, 'e');
    assert.match(expectApiError('q=a&cx=c&siteSearchFilter=include').detail, /siteSearchFilter/);
  });

  test('sort rejects characters that would corrupt the backend query', () => {
    assert.equal(parse('q=a&cx=c&sort=date').sort, 'date');
    assert.equal(parse('q=a&cx=c&sort=date:d').sort, 'date:d');
    assert.match(expectApiError('q=a&cx=c&sort=date%20OR%20x').detail, /'sort'/);
  });
});

describe('buildQueryString', () => {
  const base = (over: Partial<CseParams> = {}): CseParams => ({
    key: undefined,
    cx: 'default',
    q: 'widgets',
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

  test('plain query passes through untouched', () => {
    assert.equal(buildQueryString(base(), undefined), 'widgets');
  });

  test('siteSearch include and exclude', () => {
    assert.equal(buildQueryString(base({ siteSearch: 'rust-lang.org' }), undefined), 'widgets site:rust-lang.org');
    assert.equal(
      buildQueryString(base({ siteSearch: 'rust-lang.org', siteSearchFilter: 'e' }), undefined),
      'widgets -site:rust-lang.org',
    );
  });

  test('the profile site applies when the client sends none', () => {
    assert.equal(buildQueryString(base(), 'docs.rs'), 'widgets site:docs.rs');
    // An explicit siteSearch overrides the profile.
    assert.equal(buildQueryString(base({ siteSearch: 'a.com' }), 'docs.rs'), 'widgets site:a.com');
  });

  test('a profile site is never turned into an exclusion by the client filter', () => {
    assert.equal(buildQueryString(base({ siteSearchFilter: 'e' }), 'docs.rs'), 'widgets site:docs.rs');
  });

  test('fileType, exactTerms and excludeTerms become search operators', () => {
    assert.equal(buildQueryString(base({ fileType: 'pdf' }), undefined), 'widgets filetype:pdf');
    assert.equal(buildQueryString(base({ exactTerms: 'async runtime' }), undefined), 'widgets "async runtime"');
    assert.equal(buildQueryString(base({ excludeTerms: 'tokio smol' }), undefined), 'widgets -tokio -smol');
  });

  test('quotes inside exactTerms cannot break out of the phrase', () => {
    assert.equal(buildQueryString(base({ exactTerms: 'a" OR b' }), undefined), 'widgets "a OR b"');
  });

  test('everything combines in a stable order', () => {
    assert.equal(
      buildQueryString(
        base({ siteSearch: 'x.com', fileType: 'pdf', exactTerms: 'foo', excludeTerms: 'bar' }),
        undefined,
      ),
      'widgets site:x.com filetype:pdf "foo" -bar',
    );
  });
});

describe('pageForStart', () => {
  test('maps a 1-based index onto a 1-based backend page', () => {
    assert.equal(pageForStart(1, 10), 1);
    assert.equal(pageForStart(10, 10), 1);
    assert.equal(pageForStart(11, 10), 2);
    assert.equal(pageForStart(21, 10), 3);
    assert.equal(pageForStart(91, 10), 10);
  });
});
