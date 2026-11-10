import { cloudflareFetch } from '../cloudflareApi.js';

/**
 * `{query, batch}` over the D1 REST `/query` endpoint (same executor shape
 * factory-cli uses). `batch` is one request that D1 runs as a single
 * transaction and returns one `results` array per statement.
 * `cloudflareFetchFn` is injectable for tests; real callers never pass it.
 */
export function createD1Executor({ apiToken, accountId, databaseId, cloudflareFetchFn = cloudflareFetch }) {
  const path = `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  const post = (body) => cloudflareFetchFn(path, { apiToken, method: 'POST', body });
  return {
    async query(sql, params = []) {
      const [result] = await post({ sql, params });
      return result.results;
    },
    async batch(statements) {
      const results = await post({ batch: statements.map(({ sql, params = [] }) => ({ sql, params })) });
      return results.map((result) => result.results);
    },
  };
}
