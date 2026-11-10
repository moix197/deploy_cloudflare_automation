import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chooseShard, shardNames } from './shards.js';

test('shardNames are wx-demos-01 … wx-demos-10', () => {
  const names = shardNames();
  assert.equal(names.length, 10);
  assert.equal(names[0], 'wx-demos-01');
  assert.equal(names[9], 'wx-demos-10');
});

test('an existing placement wins even when another shard is emptier', () => {
  const shard = chooseShard({ placement: { shard: 'wx-demos-07' }, loads: { 'wx-demos-07': 17_999 }, fileCount: 500 });
  assert.equal(shard, 'wx-demos-07');
});

test('a new slug goes to the shard with the fewest files; ties go to the lowest number', () => {
  const loads = { 'wx-demos-01': 900, 'wx-demos-02': 300, 'wx-demos-03': 300 };
  assert.equal(chooseShard({ placement: null, loads, fileCount: 10, shards: ['wx-demos-01', 'wx-demos-02', 'wx-demos-03'] }), 'wx-demos-02');
  assert.equal(chooseShard({ placement: null, loads: {}, fileCount: 10 }), 'wx-demos-01');
});

test('shards that would pass the budget are skipped; null when none fits', () => {
  const shards = ['wx-demos-01', 'wx-demos-02'];
  const loads = { 'wx-demos-01': 17_000, 'wx-demos-02': 17_500 };
  assert.equal(chooseShard({ placement: null, loads, fileCount: 1_000, shards }), 'wx-demos-01');
  assert.equal(chooseShard({ placement: null, loads, fileCount: 1_001, shards }), null);
});
