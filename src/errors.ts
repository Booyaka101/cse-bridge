/**
 * Google API error envelopes.
 *
 * Clients written against customsearch/v1 branch on `error.code`,
 * `error.status` and `error.errors[0].reason`. The googleapis Node client in
 * particular reads `error.errors[0].reason` when building the Error it throws,
 * so these shapes are part of the wire contract, not decoration.
 */

export interface GoogleApiErrorItem {
  message: string;
  domain: string;
  reason: string;
  location?: string;
  locationType?: string;
}

export interface GoogleApiErrorEnvelope {
  error: {
    code: number;
    message: string;
    errors: GoogleApiErrorItem[];
    status: string;
  };
}

/** An error that already knows exactly which Google envelope it becomes. */
export class ApiError extends Error {
  readonly code: number;
  readonly status: string;
  readonly reason: string;
  readonly detail: string;
  readonly location: string | undefined;
  readonly locationType: string | undefined;

  constructor(opts: {
    code: number;
    /** Top-level `error.message` — the canonical Google wording. */
    message: string;
    /** `errors[0].message` — may be more specific than the top-level message. */
    detail?: string;
    status: string;
    reason: string;
    location?: string;
    locationType?: string;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.reason = opts.reason;
    this.detail = opts.detail ?? opts.message;
    this.location = opts.location;
    this.locationType = opts.locationType;
  }

  toEnvelope(): GoogleApiErrorEnvelope {
    const item: GoogleApiErrorItem = {
      message: this.detail,
      domain: 'global',
      reason: this.reason,
    };
    if (this.location !== undefined) {
      item.location = this.location;
      item.locationType = this.locationType ?? 'parameter';
    }
    return {
      error: {
        code: this.code,
        message: this.message,
        errors: [item],
        status: this.status,
      },
    };
  }
}

/**
 * Google's response to any malformed query parameter. The top-level message is
 * always this exact string; the per-error message carries the specifics.
 */
export function invalidArgument(detail: string, location?: string): ApiError {
  return new ApiError({
    code: 400,
    message: 'Request contains an invalid argument.',
    detail,
    status: 'INVALID_ARGUMENT',
    reason: 'badRequest',
    ...(location === undefined ? {} : { location, locationType: 'parameter' }),
  });
}

/** No `key` supplied while CSE_BRIDGE_KEYS is set. */
export function missingApiKey(): ApiError {
  return new ApiError({
    code: 403,
    message: 'The request is missing a valid API key.',
    status: 'PERMISSION_DENIED',
    reason: 'forbidden',
  });
}

/** `key` supplied but not in CSE_BRIDGE_KEYS. */
export function invalidApiKey(): ApiError {
  return new ApiError({
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    reason: 'badRequest',
  });
}

/** SearXNG answered 429 — it is rate limiting us (or its own upstreams are). */
export function rateLimited(detail = 'Quota exceeded for the current request rate.'): ApiError {
  return new ApiError({
    code: 429,
    message: 'Quota exceeded for the current request rate.',
    detail,
    status: 'RESOURCE_EXHAUSTED',
    reason: 'rateLimitExceeded',
  });
}

/** SearXNG unreachable, timed out, or answered with something unusable. */
export function backendUnavailable(detail: string): ApiError {
  return new ApiError({
    code: 503,
    message: 'The service is currently unavailable.',
    detail,
    status: 'UNAVAILABLE',
    reason: 'backendError',
  });
}

/** Unknown path or method. */
export function notFound(detail = 'The requested URL was not found on this server.'): ApiError {
  return new ApiError({
    code: 404,
    message: 'Requested entity was not found.',
    detail,
    status: 'NOT_FOUND',
    reason: 'notFound',
  });
}
