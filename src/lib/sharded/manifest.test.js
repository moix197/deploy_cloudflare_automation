import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffSlugManifest, mergeSlugManifest, toSlugManifest, withoutSlug } from './manifest.js';

const stored = {
  '/demo/index.html': 'old-home',
  '/demo/stale.html': 'gone-in-new-build',
  '/demo-two/index.html': 'other-demo',
  '/other/index.html': 'other',
};

test('toSlugManifest prefixes every asset with /<slug>/', () => {
  assert.deepEqual(toSlugManifest('demo', [{ name: 'index.html', hash: 'h1' }, { name: 'img/a.webp', hash: 'h2' }]), {
    '/demo/index.html': 'h1',
    '/demo/img/a.webp': 'h2',
  });
});

test('merge replaces the slug entries, drops its stale ones and keeps every other demo', () => {
  const merged = mergeSlugManifest(stored, 'demo', { '/demo/index.html': 'new-home', '/demo/new.css': 'css' });
  assert.deepEqual(merged, {
    '/demo-two/index.html': 'other-demo',
    '/other/index.html': 'other',
    '/demo/index.html': 'new-home',
    '/demo/new.css': 'css',
  });
});

test('merge into an empty shard is just the slug manifest', () => {
  assert.deepEqual(mergeSlugManifest({}, 'demo', { '/demo/index.html': 'h' }), { '/demo/index.html': 'h' });
});

test('withoutSlug removes only that slug, not a slug sharing its prefix', () => {
  assert.deepEqual(withoutSlug(stored, 'demo'), {
    '/demo-two/index.html': 'other-demo',
    '/other/index.html': 'other',
  });
  assert.deepEqual(withoutSlug(stored, 'absent'), stored);
});

test('diff of an unchanged redeploy touches no rows', () => {
  const same = { '/demo/index.html': 'old-home', '/demo/stale.html': 'gone-in-new-build' };
  assert.deepEqual(diffSlugManifest(stored, 'demo', same), { deletes: [], upserts: [] });
});

test('diff deletes dropped paths, upserts new and changed ones, ignores other demos', () => {
  const diff = diffSlugManifest(stored, 'demo', { '/demo/index.html': 'new-home', '/demo/new.css': 'css' });
  assert.deepEqual(diff, {
    deletes: ['/demo/stale.html'],
    upserts: [['/demo/index.html', 'new-home'], ['/demo/new.css', 'css']],
  });
});

test('diff of a first deploy upserts every entry', () => {
  const slugManifest = { '/fresh/index.html': 'h1', '/fresh/a.css': 'h2' };
  assert.deepEqual(diffSlugManifest(stored, 'fresh', slugManifest), { deletes: [], upserts: Object.entries(slugManifest) });
});
