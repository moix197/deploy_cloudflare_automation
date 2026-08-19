import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateSlug, validateDir } from './validate.js';
import { InvalidSlugError, DirectoryNotFoundError, EmptyDirectoryError } from '../errors.js';

test('validateSlug accepts valid slugs', () => {
  assert.equal(validateSlug('a'), 'a');
  assert.equal(validateSlug('my-app'), 'my-app');
  assert.equal(validateSlug('a'.repeat(58)), 'a'.repeat(58));
});

test('validateSlug rejects invalid characters', () => {
  assert.throws(() => validateSlug('My-App'), InvalidSlugError);
  assert.throws(() => validateSlug('my_app'), InvalidSlugError);
  assert.throws(() => validateSlug('Invalid_Slug!'), InvalidSlugError);
});

test('validateSlug rejects a leading or trailing dash', () => {
  assert.throws(() => validateSlug('-my-app'), InvalidSlugError);
  assert.throws(() => validateSlug('my-app-'), InvalidSlugError);
});

test('validateSlug rejects slugs over the length boundary', () => {
  assert.throws(() => validateSlug('a'.repeat(59)), InvalidSlugError);
});

test('validateSlug rejects non-string input without crashing', () => {
  assert.throws(() => validateSlug(undefined), InvalidSlugError);
});

test('validateDir throws DirectoryNotFoundError for a missing path', () => {
  assert.throws(() => validateDir(join(tmpdir(), 'definitely-does-not-exist-cfpd')), DirectoryNotFoundError);
});

test('validateDir throws DirectoryNotFoundError when the path is a file, not a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-validate-'));
  const filePath = join(dir, 'not-a-dir.txt');
  writeFileSync(filePath, 'x');
  try {
    assert.throws(() => validateDir(filePath), DirectoryNotFoundError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateDir throws EmptyDirectoryError for an empty directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-validate-'));
  try {
    assert.throws(() => validateDir(dir), EmptyDirectoryError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateDir returns the directory path when it exists and is non-empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfpd-validate-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  try {
    assert.equal(validateDir(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
