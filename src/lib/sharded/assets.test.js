import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path, { join } from 'node:path';
import { tmpdir } from 'node:os';

import { hashAssetFile, walkAssets } from './assets.js';

const WRANGLER_CLI = join(path.dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'wrangler-dist', 'cli.js');

/**
 * wrangler does not export `hashFile`, so the test lifts its source out of
 * the installed bundle and evaluates it with the same `fs`, `path` and the
 * `blake3-wasm` module wrangler itself resolves — a wrangler upgrade that
 * changes the algorithm fails this test instead of silently re-hashing.
 */
function loadWranglerHashFile() {
  const source = readFileSync(WRANGLER_CLI, 'utf8');
  const match = source.match(/hashFile = \/\* @__PURE__ \*\/ __name3\(\(filepath\) => \{([\s\S]*?)\}, "hashFile"\)/);
  assert.ok(match, 'hashFile not found in the installed wrangler bundle');
  const blake3Wasm = createRequire(WRANGLER_CLI)('blake3-wasm');
  return new Function('fs6', 'path31', 'blake3Wasm', `return (filepath) => {${match[1]}}`)(fs, path, blake3Wasm);
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-assets-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('hashAssetFile matches wrangler hashFile for text, binary, empty and extensionless files', () =>
  withTempDir((dir) => {
    const wranglerHashFile = loadWranglerHashFile();
    const files = {
      'index.html': '<!doctype html><title>ñandú</title>',
      'img/photo.webp': randomBytes(4096),
      'empty.css': '',
      'CNAME': 'example.com',
      'a.b.min.js': 'console.log(1)',
      'UPPER.PNG': randomBytes(512),
    };
    mkdirSync(join(dir, 'img'));
    for (const [name, contents] of Object.entries(files)) {
      const filePath = join(dir, name);
      writeFileSync(filePath, contents);
      assert.equal(hashAssetFile(filePath), wranglerHashFile(filePath), name);
    }
  }));

test('same bytes under a different extension hash differently (extension is part of the key)', () =>
  withTempDir((dir) => {
    writeFileSync(join(dir, 'a.html'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'x');
    assert.notEqual(hashAssetFile(join(dir, 'a.html')), hashAssetFile(join(dir, 'a.txt')));
  }));

test('walkAssets lists nested files with / names, skipping wrangler-ignored entries', () =>
  withTempDir((dir) => {
    mkdirSync(join(dir, 'about'));
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, 'functions'));
    writeFileSync(join(dir, 'index.html'), 'home');
    writeFileSync(join(dir, 'about', 'index.html'), 'about');
    writeFileSync(join(dir, 'about', '_headers'), 'nested is a plain asset');
    writeFileSync(join(dir, '_headers'), '/* x');
    writeFileSync(join(dir, '_redirects'), '/a /b');
    writeFileSync(join(dir, '.DS_Store'), '');
    writeFileSync(join(dir, 'node_modules', 'x.js'), '');
    writeFileSync(join(dir, 'functions', 'api.js'), '');

    const assets = walkAssets(dir);
    assert.deepEqual(assets.map((a) => a.name), ['about/_headers', 'about/index.html', 'index.html']);
    assert.equal(assets[2].contentType, 'text/html');
    assert.equal(assets[2].size, 4);
    assert.match(assets[2].hash, /^[0-9a-f]{32}$/);
  }));
