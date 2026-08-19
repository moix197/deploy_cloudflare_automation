import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAuth } from './checkAuth.js';
import { InvalidCredentialError } from '../../errors.js';

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
          throw new Error('Cloudflare rejected the token');
        },
      }),
    (error) => error instanceof InvalidCredentialError && /rejected/i.test(error.message),
  );
});
