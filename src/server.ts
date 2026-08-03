/**
 * HTTP surface: GET /customsearch/v1 and GET /healthz.
 *
 * Everything that leaves this module is either a `customsearch#search` body or
 * a Google API error envelope, because clients parse both and nothing else.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, invalidApiKey, missingApiKey, notFound } from './errors.ts';
import { buildQueryString, dateRestrictToTimeRange, languageFor, parseParams, safeToSearxng } from './params.ts';
import { applySort, mapResponse, type CseSearchResponse } from './map.ts';
import { SearxngClient } from './searxng.ts';
import { builtinProfiles, loadProfiles, type ProfileSet } from './profiles.ts';
import { loadConfig, type Config } from './config.ts';

export const SEARCH_PATH = '/customsearch/v1';
export const HEALTH_PATH = '/healthz';

export interface BridgeOptions {
  config: Config;
  profiles?: ProfileSet;
  client?: SearxngClient;
  /** Set false to silence request logging (tests). */
  log?: boolean;
}

export interface Bridge {
  server: Server;
  config: Config;
  profiles: ProfileSet;
  listen(): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'private',
    'X-Powered-By': 'cse-bridge',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: ApiError): void {
  sendJson(res, err.code, err.toEnvelope());
}

/** Anything thrown anywhere becomes a Google envelope, never a stack trace. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError({
    code: 500,
    message: 'Internal error encountered.',
    detail: message,
    status: 'INTERNAL',
    reason: 'backendError',
  });
}

function checkKey(config: Config, key: string | undefined): void {
  if (config.keys.size === 0) return; // Auth disabled: accept any key, including none.
  if (key === undefined) throw missingApiKey();
  if (!config.keys.has(key)) throw invalidApiKey();
}

/** Run one search request end to end. Exported so tests can skip HTTP. */
export async function handleSearch(
  searchParams: URLSearchParams,
  deps: { config: Config; profiles: ProfileSet; client: SearxngClient },
): Promise<CseSearchResponse> {
  const params = parseParams(searchParams);
  checkKey(deps.config, params.key);

  const profile = deps.profiles.get(params.cx);
  const query = buildQueryString(params, profile.site);
  const language = languageFor(params.lr, params.hl) ?? profile.language;
  const timeRange = params.dateRestrict ? dateRestrictToTimeRange(params.dateRestrict) : null;

  const startedAt = process.hrtime.bigint();
  const { results } = await deps.client.fetchWindow(
    {
      query,
      language,
      safesearch: safeToSearxng(params.safe),
      timeRange,
      engines: profile.engines,
      categories: profile.categories,
    },
    params.start,
    params.num,
  );
  const searchTime = Number(process.hrtime.bigint() - startedAt) / 1e9;

  // Sort before slicing: `sort=date` must reorder the whole result set, not
  // just whichever ten results happen to land on this page.
  const ordered = applySort(results, params.sort);
  const window = ordered.slice(params.start - 1, params.start - 1 + params.num);
  const hasMore = ordered.length > params.start - 1 + window.length;

  return mapResponse({ params, results: window, hasMore, searchTime });
}

export function createBridge(opts: BridgeOptions): Bridge {
  const config = opts.config;
  const profiles = opts.profiles ?? loadProfiles(config.profilesFile);
  const client =
    opts.client ??
    new SearxngClient({
      baseUrl: config.searxngUrl,
      timeoutMs: config.timeoutMs,
      cacheTtlMs: config.cacheTtlMs,
      cacheMax: config.cacheMax,
    });
  const shouldLog = opts.log !== false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, toApiError(err));
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendError(res, notFound('The request URL could not be parsed.'));
      return;
    }

    const started = Date.now();
    const finish = (status: number): void => {
      if (shouldLog) {
        process.stdout.write(`${req.method} ${url.pathname}${url.search} -> ${status} (${Date.now() - started}ms)\n`);
      }
    };

    if (url.pathname === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, notFound(`Method ${req.method} is not supported on ${HEALTH_PATH}.`));
        finish(404);
        return;
      }
      const deep = url.searchParams.get('deep') === '1';
      const health = await probeBackend(client, deep);
      const status = health.searxng === 'ok' ? 200 : 503;
      sendJson(res, status, {
        status: health.searxng === 'ok' ? 'ok' : 'degraded',
        service: 'cse-bridge',
        version: VERSION,
        searxng: { url: config.searxngUrl, status: health.searxng, probe: deep ? 'search' : 'liveness', detail: health.detail },
        profiles: profiles.names(),
        profilesSource: profiles.source,
        authRequired: config.keys.size > 0,
        cachedQueries: client.cacheSize,
      });
      finish(status);
      return;
    }

    if (url.pathname !== SEARCH_PATH) {
      sendError(res, notFound(`No endpoint at ${url.pathname}. This bridge serves ${SEARCH_PATH} and ${HEALTH_PATH}.`));
      finish(404);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, notFound(`Method ${req.method} is not supported on ${SEARCH_PATH}.`));
      finish(404);
      return;
    }

    try {
      const body = await handleSearch(url.searchParams, { config, profiles, client });
      sendJson(res, 200, body);
      finish(200);
    } catch (err) {
      const apiErr = toApiError(err);
      sendError(res, apiErr);
      finish(apiErr.code);
    }
  }

  return {
    server,
    config,
    profiles,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;
          resolve({ port, host: config.host });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

async function probeBackend(
  client: SearxngClient,
  deep: boolean,
): Promise<{ searxng: 'ok' | 'unreachable'; detail: string }> {
  try {
    if (deep) {
      await client.searchPage({ query: 'cse-bridge healthcheck', pageno: 1, safesearch: 0 });
      return { searxng: 'ok', detail: 'JSON search API reachable and format=json is enabled.' };
    }
    await client.ping();
    return { searxng: 'ok', detail: 'Reachable. Use /healthz?deep=1 to verify format=json is enabled.' };
  } catch (err) {
    return { searxng: 'unreachable', detail: err instanceof ApiError ? err.detail : String(err) };
  }
}

export const VERSION = '1.0.2';

/** Build a bridge from process.env. Used by bin/cse-bridge.js. */
export function bridgeFromEnv(env: NodeJS.ProcessEnv = process.env): Bridge {
  const config = loadConfig(env);
  return createBridge({ config });
}

export { loadConfig, builtinProfiles, SearxngClient };
export type { Config, ProfileSet };
