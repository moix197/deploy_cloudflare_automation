import { resolveAuth } from '../../auth/resolveAuth.js';
import { verifyToken, CloudflareApiError, CloudflareHttpError } from '../../lib/cloudflareApi.js';
import { InvalidCredentialError } from '../../errors.js';

/**
 * A `CloudflareApiError` means Cloudflare understood the request and
 * rejected it at the API level (the outcome `/user/tokens/verify` always
 * returns for a bad token), and HTTP 401/403 means the transport itself
 * rejected the credential. Anything else (DNS failure, a 5xx, a malformed
 * response) is not evidence the token is wrong and must propagate unchanged.
 */
function isCredentialRejection(error) {
  if (error instanceof CloudflareApiError) return true;
  if (error instanceof CloudflareHttpError) return error.status === 401 || error.status === 403;
  return false;
}

async function verifyOrThrowInvalidCredential(apiToken, verifyTokenFn) {
  try {
    return await verifyTokenFn({ apiToken });
  } catch (cause) {
    if (!isCredentialRejection(cause)) throw cause;
    throw new InvalidCredentialError('CLOUDFLARE_API_TOKEN is set but Cloudflare rejected it', cause);
  }
}

/**
 * Resolves credentials and verifies the token against the real Cloudflare
 * API. `resolveAuthFn`/`verifyTokenFn` are injectable for tests.
 */
export async function checkAuth({ resolveAuthFn = resolveAuth, verifyTokenFn = verifyToken } = {}) {
  const { apiToken, accountId } = resolveAuthFn();
  const result = await verifyOrThrowInvalidCredential(apiToken, verifyTokenFn);
  return { accountId, tokenStatus: result.status, tokenId: result.id };
}
