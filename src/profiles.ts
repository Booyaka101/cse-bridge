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
 */

import { readFileSync } from 'node:fs';

export interface Profile {
  /** SearXNG `engines=` (comma-joined). Empty means "instance default". */
  engines: string[];
  /** SearXNG `categories=`. Empty means "instance default". */
  categories: string[];
  /** Implicit `site:` restriction applied to every query on this cx. */
  site: string | undefined;
  /** Default language when the client sends neither `lr` nor `hl`. */
  language: string | undefined;
  /** Human label, surfaced nowhere on the wire but useful in logs. */
  description: string | undefined;
}

export const DEFAULT_PROFILE: Profile = {
  engines: [],
  categories: [],
  site: undefined,
  language: undefined,
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

    const sep = content.indexOf(':');
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

function toProfile(block: Record<string, YamlValue>): Profile {
  return {
    engines: asList(block['engines']),
    categories: asList(block['categories']),
    site: asString(block['site']),
    language: asString(block['language']),
    description: asString(block['description']),
  };
}

/** Build a ProfileSet from YAML text. */
export function profilesFromYaml(text: string, source: string | null): ProfileSet {
  const doc = parseYaml(text);
  const map = new Map<string, Profile>();
  for (const [name, block] of Object.entries(doc)) {
    map.set(name, toProfile(block));
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
