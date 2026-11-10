import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { ShardLockLostError, ShardLockTimeoutError } from '../../errors.js';

export const LOCK_LEASE_MS = 5 * 60_000;
export const LOCK_WAIT_MS = 5 * 60_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function newLockHolder() {
  return `${hostname()}:${process.pid}:${randomUUID()}`;
}

const readHolder = (shard) => ({ sql: 'SELECT holder FROM shard_locks WHERE shard = ?', params: [shard] });

async function holdsAfter(db, shard, holder, statement) {
  const [, rows] = await db.batch([statement, readHolder(shard)]);
  return rows[0]?.holder === holder;
}

/**
 * One atomic statement takes the row when it is free, expired, or already
 * ours; the read in the same transaction tells us who holds it now.
 */
export function tryAcquireLease(db, { shard, holder, now, leaseMs = LOCK_LEASE_MS }) {
  return holdsAfter(db, shard, holder, {
    sql: `INSERT INTO shard_locks (shard, holder, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(shard) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
      WHERE shard_locks.expires_at <= ? OR shard_locks.holder = excluded.holder`,
    params: [shard, holder, now + leaseMs, now],
  });
}

/** Extends our lease; false when someone else has taken the shard since. */
export function renewLease(db, { shard, holder, now, leaseMs = LOCK_LEASE_MS }) {
  return holdsAfter(db, shard, holder, {
    sql: 'UPDATE shard_locks SET expires_at = ? WHERE shard = ? AND holder = ?',
    params: [now + leaseMs, shard, holder],
  });
}

export function releaseLease(db, { shard, holder }) {
  return db.batch([{ sql: 'DELETE FROM shard_locks WHERE shard = ? AND holder = ?', params: [shard, holder] }]);
}

export function retryDelayMs(attempt) {
  return Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
}

async function acquireWithBackoff(db, { shard, holder, now, sleep, leaseMs, waitMs }) {
  const startedAt = now();
  for (let attempt = 0; ; attempt += 1) {
    if (await tryAcquireLease(db, { shard, holder, now: now(), leaseMs })) return;
    const waited = now() - startedAt;
    if (waited >= waitMs) throw new ShardLockTimeoutError(shard, waited);
    await sleep(Math.min(retryDelayMs(attempt), waitMs - waited));
  }
}

/**
 * Runs `fn(lease)` while holding the shard's lease. `lease.renew()` extends
 * it (throwing `ShardLockLostError` if it was taken over) and `lease.guard`
 * is a SQL condition writes can embed so they only land while we still hold
 * it. `now`/`sleep`/`holder` are injectable for tests; real callers never
 * pass them.
 */
export async function withShardLock(db, shard, fn, {
  holder = newLockHolder(),
  now = Date.now,
  sleep = sleepMs,
  leaseMs = LOCK_LEASE_MS,
  waitMs = LOCK_WAIT_MS,
} = {}) {
  await acquireWithBackoff(db, { shard, holder, now, sleep, leaseMs, waitMs });
  const lease = {
    shard,
    holder,
    guard: { sql: 'EXISTS (SELECT 1 FROM shard_locks WHERE shard = ? AND holder = ?)', params: [shard, holder] },
    async renew() {
      if (!(await renewLease(db, { shard, holder, now: now(), leaseMs }))) throw new ShardLockLostError(shard);
    },
  };
  try {
    return await fn(lease);
  } finally {
    // A failed release is harmless (the lease expires on its own) and must
    // not mask fn's own result or error.
    await releaseLease(db, { shard, holder }).catch(() => {});
  }
}
