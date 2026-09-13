/**
 * Runtime configuration, read once from the environment.
 *
 * Every knob has a working default so `npx cse-bridge` next to a local SearXNG
 * needs no configuration at all.
 */

import { DEFAULT_PAGEMAP_MAX, DEFAULT_PAGEMAP_TIMEOUT_MS, DEFAULT_PAGEMAP_TTL_MS } from './pagemap.ts';

export interface Config {
  /** Base URL of the SearXNG instance to proxy, no trailing slash. */
  searxngUrl: string;
  /** TCP port the bridge listens on. */
  port: number;
  /** Interface the bridge binds to. */
  host: string;
  /**
   * Accepted values for the `key` query param. Empty set means the bridge does
   * not check `key` at all (Google's `key` is required by clients, so it is
   * always accepted when this is empty).
   */
  keys: Set<string>;
  /** Path to profiles.yml. May be absent; a built-in default profile is used. */
  profilesFile: string;
  /** Per-request timeout against SearXNG, milliseconds. */
  timeoutMs: number;
  /**
   * How long a query's result set stays stable so paging through it does not
   * re-shuffle. 0 disables caching (and with it, disjoint deep pages).
   */
  cacheTtlMs: number;
  /** Maximum number of distinct queries held in the result-set cache. */
  cacheMax: number;
  /**
   * Reconstruct `item.pagemap` by fetching result pages. Off by default; a
   * profile's `pagemap:` key overrides this per `cx`.
   */
  pagemap: boolean;
  /** Result pages fetched per request when pagemap is on. */
  pagemapMax: number;
  /** Per-URL deadline for a pagemap fetch, milliseconds. */
  pagemapTimeoutMs: number;
  /** Deadline for the whole enrichment pass, milliseconds. */
  pagemapBudgetMs: number;
  /** Lifetime of a cached page, milliseconds. 0 disables the pagemap cache. */
  pagemapTtlMs: number;
  /** Let pagemap fetch loopback/private-network hosts. */
  pagemapAllowPrivate: boolean;
}

const DEFAULTS = {
  searxngUrl: 'http://localhost:8888',
  port: 8080,
  host: '0.0.0.0',
  profilesFile: 'profiles.yml',
  timeoutMs: 20_000,
  cacheTtlMs: 300_000,
  cacheMax: 256,
  pagemap: false,
  pagemapMax: DEFAULT_PAGEMAP_MAX,
  pagemapTimeoutMs: DEFAULT_PAGEMAP_TIMEOUT_MS,
  pagemapTtlMs: DEFAULT_PAGEMAP_TTL_MS,
  pagemapAllowPrivate: false,
} as const;

/**
 * Waves of `PAGEMAP_CONCURRENCY` fetches needed to cover the default
 * `pagemapMax`. The budget therefore scales with the per-URL timeout instead of
 * silently capping it at some fixed number of seconds.
 */
const PAGEMAP_BUDGET_WAVES = 3;

export class ConfigError extends Error {}

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigError(`${name} must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseNonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseUrl(raw: string | undefined, name: string, fallback: string): string {
  const value = raw === undefined || raw === '' ? fallback : raw;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http:// or https://, got ${JSON.stringify(value)}`);
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

const TRUE_WORDS = ['on', 'true', 'yes', '1'];
const FALSE_WORDS = ['off', 'false', 'no', '0'];

function parseToggle(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_WORDS.includes(value)) return true;
  if (FALSE_WORDS.includes(value)) return false;
  throw new ConfigError(`${name} must be on or off (true/false and 1/0 also work), got ${JSON.stringify(raw)}`);
}

/** Parse a process environment into a validated Config. Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const keys = new Set(
    (env['CSE_BRIDGE_KEYS'] ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
  );

  // The enrichment budget defaults to a multiple of the per-URL timeout, so it
  // has to be resolved before the object literal.
  const pagemapTimeoutMs = parsePositiveInt(
    env['CSE_BRIDGE_PAGEMAP_TIMEOUT_MS'],
    'CSE_BRIDGE_PAGEMAP_TIMEOUT_MS',
    DEFAULTS.pagemapTimeoutMs,
  );

  return {
    searxngUrl: parseUrl(env['SEARXNG_URL'], 'SEARXNG_URL', DEFAULTS.searxngUrl),
    port: parsePort(env['PORT'], 'PORT', DEFAULTS.port),
    host: env['HOST'] && env['HOST'] !== '' ? env['HOST'] : DEFAULTS.host,
    keys,
    profilesFile: env['PROFILES_FILE'] && env['PROFILES_FILE'] !== '' ? env['PROFILES_FILE'] : DEFAULTS.profilesFile,
    timeoutMs: parsePositiveInt(env['CSE_BRIDGE_TIMEOUT_MS'], 'CSE_BRIDGE_TIMEOUT_MS', DEFAULTS.timeoutMs),
    cacheTtlMs: parseNonNegativeInt(env['CSE_BRIDGE_CACHE_TTL_MS'], 'CSE_BRIDGE_CACHE_TTL_MS', DEFAULTS.cacheTtlMs),
    cacheMax: parsePositiveInt(env['CSE_BRIDGE_CACHE_MAX'], 'CSE_BRIDGE_CACHE_MAX', DEFAULTS.cacheMax),
    pagemap: parseToggle(env['CSE_BRIDGE_PAGEMAP'], 'CSE_BRIDGE_PAGEMAP', DEFAULTS.pagemap),
    pagemapMax: parseNonNegativeInt(env['CSE_BRIDGE_PAGEMAP_MAX'], 'CSE_BRIDGE_PAGEMAP_MAX', DEFAULTS.pagemapMax),
    pagemapTimeoutMs,
    pagemapBudgetMs: parsePositiveInt(
      env['CSE_BRIDGE_PAGEMAP_BUDGET_MS'],
      'CSE_BRIDGE_PAGEMAP_BUDGET_MS',
      pagemapTimeoutMs * PAGEMAP_BUDGET_WAVES,
    ),
    pagemapTtlMs: parseNonNegativeInt(env['CSE_BRIDGE_PAGEMAP_TTL_MS'], 'CSE_BRIDGE_PAGEMAP_TTL_MS', DEFAULTS.pagemapTtlMs),
    pagemapAllowPrivate: parseToggle(
      env['CSE_BRIDGE_PAGEMAP_ALLOW_PRIVATE'],
      'CSE_BRIDGE_PAGEMAP_ALLOW_PRIVATE',
      DEFAULTS.pagemapAllowPrivate,
    ),
  };
}
