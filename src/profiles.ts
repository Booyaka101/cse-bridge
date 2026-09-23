/**
 * `cx` -> backend profile resolution.
 *
 * Google's `cx` identifies a Programmable Search Engine: which sites it covers
 * and how it is tuned. Here it selects a named block in profiles.yml, so an
 * existing client keeps passing its own cx string and you decide, server-side,
 * what that means. An unknown cx falls back to the `default` profile — never an
 * error, because a migrating client cannot change the cx it sends.
 *
 * The YAML subset understood here is deliberately tiny (no external parser):
 *   key: value            scalars, optionally 'single' or "double" quoted
 *   key: [a, b]           inline flow sequences
 *   key:                  block sequences
 *     - a
 *   name:                 one level of nested mapping (the profile block)
 *     key: value
 *   # comments and blank lines
 *
 * `sites` and `exclude` carry a Programmable Search Engine's site list. Each
 * entry is a pattern in Google's annotation style, see {@link matchUrl}.
 */

import { readFileSync } from 'node:fs';

export interface Profile {
  /** SearXNG `engines=` (comma-joined). Empty means "instance default". */
  engines: string[];
  /** SearXNG `categories=`. Empty means "instance default". */
  categories: string[];
  /**
   * Site patterns this cx is restricted to. Empty means no restriction. The
   * `site:` key is accepted as sugar for a one-entry list.
   */
  sites: string[];
  /** Site patterns never returned on this cx. Excludes win over `sites`. */
  exclude: string[];
  /** @deprecated The first entry of `sites`, kept for 1.2 callers. */
  site: string | undefined;
  /** Default language when the client sends neither `lr` nor `hl`. */
  language: string | undefined;
  /** Human label, surfaced nowhere on the wire but useful in logs. */
  description: string | undefined;
  /**
   * Per-cx override of `CSE_BRIDGE_PAGEMAP`. `undefined` means "whatever the
   * environment says", which is how a profile that never mentions pagemap keeps
   * behaving exactly as it did before the key existed.
   */
  pagemap: boolean | undefined;
}

export const DEFAULT_PROFILE: Profile = {
  engines: [],
  categories: [],
  sites: [],
  exclude: [],
  site: undefined,
  language: undefined,
  pagemap: undefined,
  description: 'Built-in default: whatever the SearXNG instance is configured to search.',
};

export interface ProfileSet {
  /** Resolve a cx, falling back to `default` for anything unknown. */
  get(cx: string): Profile;
  /** Profile names actually defined, for /healthz and startup logging. */
  names(): string[];
  /** Where these came from: a file path, or null for the built-in default. */
  source: string | null;
}

export class ProfilesError extends Error {}

type YamlValue = string | string[] | null;
type YamlDoc = Record<string, Record<string, YamlValue>>;

function stripComment(line: string): string {
  // Only strip a '#' that is not inside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // A '#' only starts a comment at line start or after whitespace.
      if (i === 0 || /\s/.test(line[i - 1] ?? '')) return line.slice(0, i);
    }
  }
  return line;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Where "key: value" splits. YAML only treats a colon followed by a space (or
 * the end of the line) as the separator, which is what lets an old-style cx
 * like `017576662512468239146:omuauf_lfve:` be a key. A line with no such
 * colon falls back to the first one, as this parser always accepted `key:value`.
 */
function keySeparator(content: string): number {
  let inSingle = false;
  let inDouble = false;
  let first = -1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = content[i + 1];
      if (next === undefined || /\s/.test(next)) return i;
      if (first === -1) first = i;
    }
  }
  return first;
}

function scalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((p) => unquote(p)).filter((p) => p.length > 0);
  }
  return unquote(s);
}

/** Parse the supported YAML subset. Exported for tests. */
export function parseYaml(text: string): YamlDoc {
  const doc: YamlDoc = {};
  let currentBlock: Record<string, YamlValue> | null = null;
  let currentBlockName = '';
  let pendingListKey: string | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const line = stripComment(rawLine);
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('---')) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    // Block sequence item, e.g. "  - duckduckgo"
    if (content.startsWith('- ') || content === '-') {
      if (currentBlock === null || pendingListKey === null) {
        throw new ProfilesError(`profiles: line ${i + 1}: list item outside of a key`);
      }
      const item = unquote(content === '-' ? '' : content.slice(2));
      const existing = currentBlock[pendingListKey];
      if (Array.isArray(existing)) existing.push(item);
      else currentBlock[pendingListKey] = [item];
      continue;
    }

    const sep = keySeparator(content);
    if (sep === -1) {
      throw new ProfilesError(`profiles: line ${i + 1}: expected "key: value", got ${JSON.stringify(content)}`);
    }
    const key = unquote(content.slice(0, sep));
    const rest = content.slice(sep + 1).trim();

    if (indent === 0) {
      if (rest !== '') {
        throw new ProfilesError(
          `profiles: line ${i + 1}: top level must contain profile names with nested keys, not "${key}: ${rest}"`,
        );
      }
      currentBlockName = key;
      currentBlock = {};
      doc[currentBlockName] = currentBlock;
      pendingListKey = null;
      continue;
    }

    if (currentBlock === null) {
      throw new ProfilesError(`profiles: line ${i + 1}: indented key "${key}" before any profile name`);
    }

    if (rest === '') {
      // Either an empty value or the header of a block sequence.
      currentBlock[key] = [];
      pendingListKey = key;
    } else {
      currentBlock[key] = scalar(rest);
      pendingListKey = null;
    }
  }

  return doc;
}

function asList(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((v) => v.length > 0);
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function asString(value: YamlValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value[0];
  return value.length === 0 ? undefined : value;
}

const TRUE_WORDS = ['true', 'on', 'yes', '1'];
const FALSE_WORDS = ['false', 'off', 'no', '0'];

/**
 * A boolean profile key. An unreadable value is an error rather than a silent
 * fallback, for the same reason a malformed file is: guessing would send a cx
 * to a configuration nobody asked for.
 */
function asBoolean(value: YamlValue | undefined, key: string, profile: string): boolean | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  throw new ProfilesError(`profiles: ${profile}.${key} must be true or false, got ${JSON.stringify(raw)}`);
}

/** A site pattern, parsed once. */
export interface SitePattern {
  /** Lowercase, punycode, without a leading `*.`. */
  host: string;
  /** Whether subdomains of `host` match too. */
  subdomains: boolean;
  /** Matcher for the path (and query, when the pattern has one). Undefined matches any path. */
  path: RegExp | undefined;
  withQuery: boolean;
  /** Canonical form: no scheme, normalized host. */
  text: string;
  /** What goes after a backend `site:` operator: host plus the path up to the first wildcard. */
  operand: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Parse `host`, `*.host`, `host/path`, `host/path*` or any of those with a
 * scheme in front. Undefined when the text cannot be a site pattern.
 */
export function parseSitePattern(raw: string): SitePattern | undefined {
  const text = raw.trim().replace(SCHEME, '');
  if (text === '' || /[\s"]/.test(text)) return undefined;
  const slash = text.indexOf('/');
  let hostPart = slash === -1 ? text : text.slice(0, slash);
  const pathPart = slash === -1 ? '' : text.slice(slash);
  const wildcard = hostPart.startsWith('*.');
  if (wildcard) hostPart = hostPart.slice(2);
  if (hostPart === '' || hostPart.includes('*') || hostPart.includes('@')) return undefined;

  let url: URL;
  try {
    // Going through URL is what lowercases the host, turns an IDN into
    // punycode and percent-encodes the path exactly as result URLs will be.
    url = new URL(`http://${hostPart}${pathPart}`);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  if (pathPart === '') {
    // A bare host means the host and everything under it, like `site:`.
    return { host, subdomains: true, path: undefined, withQuery: false, text: host, operand: host };
  }
  const pathText = url.pathname + url.search;
  const prefix = pathText.split(/[*?]/, 1)[0]!.replace(/\/+$/, '');
  return {
    host,
    subdomains: wildcard,
    path: globToRegExp(pathText),
    withQuery: url.search !== '',
    text: `${wildcard ? '*.' : ''}${host}${pathText}`,
    operand: host + prefix,
  };
}

/**
 * `*` matches anything. A trailing `/*` also matches the directory itself
 * (`/hw/*` covers `/hw`), and a pattern with no trailing `*` is one page, with
 * or without its trailing slash.
 */
function globToRegExp(pathText: string): RegExp {
  let body = pathText;
  let tail: string;
  if (body.endsWith('/*')) {
    body = body.slice(0, -2);
    tail = '(?:/.*)?';
  } else if (body.endsWith('*')) {
    body = body.slice(0, -1);
    tail = '.*';
  } else {
    body = body.replace(/\/+$/, '');
    tail = '/?';
  }
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}${tail}$`);
}

const PATTERN_CACHE_MAX = 10_000;
const parsedPatterns = new Map<string, SitePattern | undefined>();

function cachedPattern(raw: string): SitePattern | undefined {
  if (parsedPatterns.has(raw)) return parsedPatterns.get(raw);
  if (parsedPatterns.size >= PATTERN_CACHE_MAX) parsedPatterns.clear();
  const parsed = parseSitePattern(raw);
  parsedPatterns.set(raw, parsed);
  return parsed;
}

function patternMatches(pattern: SitePattern | undefined, url: URL): boolean {
  if (pattern === undefined) return false;
  const host = url.hostname;
  if (host !== pattern.host && !(pattern.subdomains && host.endsWith(`.${pattern.host}`))) return false;
  return pattern.path === undefined || pattern.path.test(url.pathname + (pattern.withQuery ? url.search : ''));
}

/**
 * Whether `url` is inside a site list. Excludes win over includes, and an
 * empty `sites` means no include restriction. Patterns are the ones
 * {@link parseSitePattern} reads; one it cannot read matches nothing, so a
 * broken include fails closed rather than letting the whole web through.
 */
export function matchUrl(url: string, sites: readonly string[], exclude: readonly string[]): boolean {
  if (sites.length === 0 && exclude.length === 0) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (exclude.some((p) => patternMatches(cachedPattern(p), parsed))) return false;
  return sites.length === 0 || sites.some((p) => patternMatches(cachedPattern(p), parsed));
}

/** A profile's site list in canonical form, de-duplicated. A pattern it cannot read is an error. */
function asSiteList(values: string[], key: string, profile: string): string[] {
  const out = new Set<string>();
  for (const raw of values) {
    const pattern = parseSitePattern(raw);
    if (pattern === undefined) {
      throw new ProfilesError(`profiles: ${profile}.${key} has an entry that is not a site pattern: ${JSON.stringify(raw)}`);
    }
    out.add(pattern.text);
  }
  return [...out];
}

function toProfile(name: string, block: Record<string, YamlValue>): Profile {
  const sites = asSiteList([...asList(block['site']), ...asList(block['sites'])], 'sites', name);
  return {
    engines: asList(block['engines']),
    categories: asList(block['categories']),
    sites,
    exclude: asSiteList(asList(block['exclude']), 'exclude', name),
    site: sites[0],
    language: asString(block['language']),
    pagemap: asBoolean(block['pagemap'], 'pagemap', name),
    description: asString(block['description']),
  };
}

/** Build a ProfileSet from YAML text. */
export function profilesFromYaml(text: string, source: string | null): ProfileSet {
  const doc = parseYaml(text);
  const map = new Map<string, Profile>();
  for (const [name, block] of Object.entries(doc)) {
    map.set(name, toProfile(name, block));
  }
  const fallback = map.get('default') ?? DEFAULT_PROFILE;
  return {
    get: (cx: string) => map.get(cx) ?? fallback,
    names: () => [...map.keys()],
    source,
  };
}

/** A ProfileSet with only the built-in default (used when no file exists). */
export function builtinProfiles(): ProfileSet {
  return {
    get: () => DEFAULT_PROFILE,
    names: () => ['default'],
    source: null,
  };
}

/**
 * Load profiles from disk. A missing file is not an error — the bridge works
 * out of the box against a plain SearXNG instance. A malformed file IS an
 * error, because silently ignoring it would send every query to the wrong
 * backend configuration.
 */
export function loadProfiles(path: string): ProfileSet {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return builtinProfiles();
    throw new ProfilesError(`profiles: cannot read ${path}: ${(err as Error).message}`);
  }
  return profilesFromYaml(text, path);
}
