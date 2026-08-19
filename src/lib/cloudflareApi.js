// Error classes live in `../errors.js` (the single home for all typed
// errors); re-exported here so existing `from './cloudflareApi.js'` imports
// across the codebase keep working without churn.
import { CloudflareHttpError, CloudflareApiError, CloudflareResponseParseError } from '../errors.js';

export { CloudflareHttpError, CloudflareApiError, CloudflareResponseParseError };

const API_BASE_URL = 'https://api.cloudflare.com/client/v4';

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
