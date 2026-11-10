import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { contentTypeFor, KNOWN_EXTENSIONS } from './contentType.js';

// The mime@3 tables wrangler bundles, resolved the way mime@3's Mime.define
// does: standard then other, `*`-prefixed extensions never override.
function loadWranglerMimeTypes() {
  const wranglerDir = dirname(createRequire(import.meta.url).resolve('wrangler/package.json'));
  const source = readFileSync(join(wranglerDir, 'wrangler-dist', 'cli.js'), 'utf8');
  const table = (file) => {
    const match = source.match(new RegExp(`mime/types/${file}\\.js"\\(exports2, module2\\) \\{\\s*init_import_meta_url\\(\\);\\s*module2\\.exports = (\\{.*\\});`));
    assert.ok(match, `mime ${file} table not found in the wrangler bundle`);
    return JSON.parse(match[1]);
  };
  const types = {};
  for (const map of [table('standard'), table('other')]) {
    for (const [type, extensions] of Object.entries(map)) {
      for (const ext of extensions) if (!ext.startsWith('*')) types[ext] = type;
    }
  }
  return types;
}

test('every known extension maps to the content type wrangler would upload it with', () => {
  const wranglerTypes = loadWranglerMimeTypes();
  for (const ext of KNOWN_EXTENSIONS) {
    assert.equal(contentTypeFor(`dir/file.${ext}`), wranglerTypes[ext], ext);
  }
});

test('unknown or missing extensions fall back to application/octet-stream', () => {
  assert.equal(contentTypeFor('file.unknownext'), 'application/octet-stream');
  assert.equal(contentTypeFor('CNAME'), 'application/octet-stream');
});
