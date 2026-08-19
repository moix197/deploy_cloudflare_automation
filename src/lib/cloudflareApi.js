import { CliError } from '../errors.js';

const API_BASE_URL = 'https://api.cloudflare.com/client/v4';

/**
 * Shared normalization for Cloudflare's `errors` array so every error type
 * exposes the same public shape: `.errors` always an array, and the first
 * error's code available for callers to branch on (e.g. code 8000003
 * meaning "slug already taken").
 */
function normalizeCloudflareErrors(errors) {
  const normalized = errors ?? [];
  const [first] = normalized;
  return { errors: normalized, cloudflareErrorCode: first?.code };
}

export class CloudflareHttpError extends CliError {
  constructor(status, statusText, errors) {
    const { errors: normalizedErrors, cloudflareErrorCode } = normalizeCloudflareErrors(errors);
    const [first] = normalizedErrors;
    const message = first
      ? `Cloudflare API HTTP error: ${status} ${statusText} (Cloudflare error ${first.code}: ${first.message})`
      : `Cloudflare API HTTP error: ${status} ${statusText}`;
    super(message, 'CLOUDFLARE_HTTP_ERROR');
    this.status = status;
    this.errors = normalizedErrors;
    this.cloudflareErrorCode = cloudflareErrorCode;
  }
}

export class CloudflareApiError extends CliError {
  constructor(errors) {
    const { errors: normalizedErrors, cloudflareErrorCode } = normalizeCloudflareErrors(errors);
    const [first] = normalizedErrors;
    const message = first
      ? `Cloudflare API error ${first.code}: ${first.message}`
      : 'Cloudflare API returned an unsuccessful response';
    super(message, 'CLOUDFLARE_API_ERROR');
    this.errors = normalizedErrors;
    this.cloudflareErrorCode = cloudflareErrorCode;
  }
}

/**
 * Distinct from `CloudflareApiError`: this means the response body could not
 * be parsed at all (a 2xx with an empty/non-JSON body), not that Cloudflare
 * understood the request and rejected it. Callers like `checkAuth` must not
 * treat this as a rejected credential.
 */
export class CloudflareResponseParseError extends CliError {
  constructor(status, statusText) {
    super(`Cloudflare API returned an unparseable response body: ${status} ${statusText}`, 'CLOUDFLARE_PARSE_ERROR');
    this.status = status;
  }
}

function buildRequestInit({ apiToken, method, body }) {
  return {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  };
}

/**
 * Cloudflare error responses aren't guaranteed to be JSON (a 5xx can return
 * an HTML error page), so a body that fails to parse must not throw a raw
 * `SyntaxError` past this point — the caller below treats it as an absent
 * envelope instead.
 */
async function parseJsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Calls the Cloudflare REST API and unwraps its `{success, errors, result}`
 * envelope. Throws `CloudflareHttpError` for non-2xx transport failures,
 * `CloudflareResponseParseError` for a 2xx response whose body could not be
 * parsed as JSON, and `CloudflareApiError` for a 2xx response with
 * `success: false`, so callers can tell "Cloudflare is unreachable/
 * misconfigured" apart from "Cloudflare understood the request and rejected
 * it". `CloudflareHttpError` and `CloudflareApiError` both carry the parsed
 * `errors` array/first Cloudflare error code when the body did include one,
 * so callers can branch on HTTP status AND Cloudflare error code (e.g. a 404
 * with code 8000003 meaning "slug already taken").
 */
export async function cloudflareFetch(path, { apiToken, method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, buildRequestInit({ apiToken, method, body }));
  const payload = await parseJsonBody(response);

  if (!response.ok) {
    throw new CloudflareHttpError(response.status, response.statusText, payload?.errors);
  }
  if (payload === null) {
    throw new CloudflareResponseParseError(response.status, response.statusText);
  }
  if (!payload.success) {
    throw new CloudflareApiError(payload.errors);
  }
  return payload.result;
}

export async function verifyToken({ apiToken }) {
  return cloudflareFetch('/user/tokens/verify', { apiToken });
}
