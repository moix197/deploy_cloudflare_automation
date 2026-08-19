import { resolveAuth } from '../../auth/resolveAuth.js';
import { verifyToken } from '../../lib/cloudflareApi.js';
import { InvalidCredentialError } from '../../errors.js';

async function verifyOrThrowInvalidCredential(apiToken, verifyTokenFn) {
  try {
    return await verifyTokenFn({ apiToken });
  } catch (cause) {
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
