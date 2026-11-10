import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSlugManifest, toSlugManifest, withoutSlug } from './manifest.js';

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
