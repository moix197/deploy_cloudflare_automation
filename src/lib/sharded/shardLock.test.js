import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShardLockLostError, ShardLockTimeoutError } from '../../errors.js';
import { releaseLease, renewLease, retryDelayMs, tryAcquireLease, withShardLock } from './shardLock.js';
import { createSqliteD1 } from './sqliteD1.testkit.js';

const shard = 'wx-demos-01';
const LEASE = 5 * 60_000;

test('a free shard is acquired; a held one is refused until its lease expires', async () => {
  const db = createSqliteD1();
  assert.equal(await tryAcquireLease(db, { shard, holder: 'a', now: 0, leaseMs: LEASE }), true);
  assert.equal(await tryAcquireLease(db, { shard, holder: 'b', now: LEASE - 1, leaseMs: LEASE }), false);
  assert.equal(await tryAcquireLease(db, { shard, holder: 'b', now: LEASE, leaseMs: LEASE }), true);
  const [row] = await db.query('SELECT holder, expires_at FROM shard_locks WHERE shard = ?', [shard]);
  assert.deepEqual(row, { holder: 'b', expires_at: 2 * LEASE });
});

test('the holder can re-acquire and renew; others cannot renew; release frees it', async () => {
  const db = createSqliteD1();
  await tryAcquireLease(db, { shard, holder: 'a', now: 0, leaseMs: LEASE });
  assert.equal(await tryAcquireLease(db, { shard, holder: 'a', now: 10, leaseMs: LEASE }), true);
  assert.equal(await renewLease(db, { shard, holder: 'a', now: 50, leaseMs: LEASE }), true);
  assert.equal(await renewLease(db, { shard, holder: 'b', now: 50, leaseMs: LEASE }), false);
  await releaseLease(db, { shard, holder: 'b' });
  assert.equal(await tryAcquireLease(db, { shard, holder: 'b', now: 60, leaseMs: LEASE }), false);
  await releaseLease(db, { shard, holder: 'a' });
  assert.equal(await tryAcquireLease(db, { shard, holder: 'b', now: 60, leaseMs: LEASE }), true);
});

test('leases on different shards are independent', async () => {
  const db = createSqliteD1();
  assert.equal(await tryAcquireLease(db, { shard: 'wx-demos-01', holder: 'a', now: 0 }), true);
  assert.equal(await tryAcquireLease(db, { shard: 'wx-demos-02', holder: 'b', now: 0 }), true);
});

test('retry delays back off exponentially and cap at 15s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(retryDelayMs), [1000, 2000, 4000, 8000, 15000, 15000]);
});

function fakeClock(start = 0) {
  let time = start;
  return { now: () => time, sleep: async (ms) => { time += ms; }, advance: (ms) => { time += ms; } };
}

test('withShardLock waits with backoff for a held shard, runs fn, then releases', async () => {
  const db = createSqliteD1();
  const clock = fakeClock();
  await tryAcquireLease(db, { shard, holder: 'other', now: 0, leaseMs: 10_000 });
  const result = await withShardLock(db, shard, async (lease) => {
    assert.equal(lease.holder, 'me');
    return 'done';
  }, { holder: 'me', now: clock.now, sleep: clock.sleep });
  assert.equal(result, 'done');
  assert.equal(clock.now(), 15_000); // slept 1s+2s+4s+8s, acquired once the 10s lease had expired
  assert.deepEqual(await db.query('SELECT * FROM shard_locks'), []);
});

test('withShardLock gives up after the wait budget with ShardLockTimeoutError', async () => {
  const db = createSqliteD1();
  const clock = fakeClock();
  await tryAcquireLease(db, { shard, holder: 'other', now: 0, leaseMs: 10 * 60_000 });
  await assert.rejects(
    withShardLock(db, shard, async () => assert.fail('must not run'), { holder: 'me', now: clock.now, sleep: clock.sleep }),
    ShardLockTimeoutError,
  );
  assert.equal(clock.now(), 5 * 60_000);
});

test('withShardLock releases even when fn throws, and renew reports a lost lease', async () => {
  const db = createSqliteD1();
  const clock = fakeClock();
  await assert.rejects(
    withShardLock(db, shard, async (lease) => {
      clock.advance(LEASE);
      await tryAcquireLease(db, { shard, holder: 'thief', now: clock.now() });
      await lease.renew();
    }, { holder: 'me', now: clock.now, sleep: clock.sleep }),
    ShardLockLostError,
  );
  const [row] = await db.query('SELECT holder FROM shard_locks WHERE shard = ?', [shard]);
  assert.equal(row.holder, 'thief'); // our release must not delete someone else's lease
});
