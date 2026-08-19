import { CliError } from '../errors.js';

const API_BASE_URL = 'https://api.cloudflare.com/client/v4';

export class CloudflareHttpError extends CliError {
  constructor(status, statusText) {
    super(`Cloudflare API HTTP error: ${status} ${statusText}`, 'CLOUDFLARE_HTTP_ERROR');
    this.status = status;
  }
}

export class CloudflareApiError extends CliError {
  constructor(errors) {
    const [first] = errors ?? [];
    const message = first
      ? `Cloudflare API error ${first.code}: ${first.message}`
      : 'Cloudflare API returned an unsuccessful response';
    super(message, 'CLOUDFLARE_API_ERROR');
    this.errors = errors;
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
 * Calls the Cloudflare REST API and unwraps its `{success, errors, result}`
 * envelope. Throws `CloudflareHttpError` for non-2xx transport failures and
 * `CloudflareApiError` for a 2xx response with `success: false`, so callers
 * can tell "Cloudflare is unreachable/misconfigured" apart from "Cloudflare
 * understood the request and rejected it".
 */
export async function cloudflareFetch(path, { apiToken, method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, buildRequestInit({ apiToken, method, body }));
  const payload = await response.json();

  if (!response.ok) {
    throw new CloudflareHttpError(response.status, response.statusText);
  }
  if (!payload.success) {
    throw new CloudflareApiError(payload.errors);
  }
  return payload.result;
}

export async function verifyToken({ apiToken }) {
  return cloudflareFetch('/user/tokens/verify', { apiToken });
}
