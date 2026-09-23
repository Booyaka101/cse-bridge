import type { CseParams } from '../src/params.ts';

/** A fully-defaulted parsed request, as parseParams would return it. */
export function cseParams(over: Partial<CseParams> = {}): CseParams {
  return {
    key: 'k',
    cx: 'default',
    q: 'test',
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
    searchType: undefined,
    imgSize: undefined,
    imgType: undefined,
    imgColorType: undefined,
    imgDominantColor: undefined,
    ...over,
  };
}
