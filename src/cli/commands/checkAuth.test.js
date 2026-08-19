import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAuth } from './checkAuth.js';
import { InvalidCredentialError } from '../../errors.js';
import { CloudflareApiError, CloudflareHttpError } from '../../lib/cloudflareApi.js';

test('returns account id and token status when the token is valid', async () => {
  const result = await checkAuth({
    resolveAuthFn: () => ({ apiToken: 'token', accountId: 'account-1' }),
    verifyTokenFn: async () => ({ id: 'token-id', status: 'active' }),
  });
  assert.deepEqual(result, { accountId: 'account-1', tokenStatus: 'active', tokenId: 'token-id' });
});

test('throws InvalidCredentialError, distinct from a missing-var error, when Cloudflare rejects the token', async () => {
  await assert.rejects(
    () =>
      checkAuth({
        resolveAuthFn: () => ({ apiToken: 'bad-token', accountId: 'account-1' }),
        verifyTokenFn: async () => {
          throw new CloudflareApiError([{ code: 1000, message: 'Invalid API Token' }]);
        },
      }),
    (error) => error instanceof InvalidCredentialError && /rejected/i.test(error.message),
  );
});

test('throws InvalidCredentialError when Cloudflare returns HTTP 401/403 for the token', async () => {
  await assert.rejects(
    () =>
      checkAuth({
        resolveAuthFn: () => ({ apiToken: 'bad-token', accountId: 'account-1' }),
        verifyTokenFn: async () => {
          throw new CloudflareHttpError(403, 'Forbidden');
        },
      }),
    (error) => error instanceof InvalidCredentialError,
  );
});

test('propagates a transport failure unchanged instead of misreporting it as an invalid token', async () => {
  const transportError = new Error('getaddrinfo ENOTFOUND api.cloudflare.com');
  await assert.rejects(
    () =>
      checkAuth({
        resolveAuthFn: () => ({ apiToken: 'token', accountId: 'account-1' }),
        verifyTokenFn: async () => {
          throw transportError;
        },
      }),
    (error) => error === transportError && !(error instanceof InvalidCredentialError),
  );
});

test('propagates a Cloudflare 500 unchanged instead of misreporting it as an invalid token', async () => {
  await assert.rejects(
    () =>
      checkAuth({
        resolveAuthFn: () => ({ apiToken: 'token', accountId: 'account-1' }),
        verifyTokenFn: async () => {
          throw new CloudflareHttpError(500, 'Internal Server Error');
        },
      }),
    (error) => error instanceof CloudflareHttpError && !(error instanceof InvalidCredentialError),
  );
});
