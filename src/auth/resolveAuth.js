import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MissingCredentialError } from '../errors.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const ENV_FILE_PATH = join(PACKAGE_ROOT, '.env');

function parseEnvFile(contents) {
  const values = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readEnvFile() {
  if (!existsSync(ENV_FILE_PATH)) return {};
  return parseEnvFile(readFileSync(ENV_FILE_PATH, 'utf8'));
}

function isBlank(value) {
  return value === undefined || value === null || value.trim() === '';
}

/**
 * An empty/whitespace-only value (e.g. `CLOUDFLARE_API_TOKEN=` left over from
 * copying `.env.example`) must be treated as unset at every precedence
 * level — otherwise it would shadow a correctly-set value lower in the
 * precedence chain instead of falling through to it.
 */
function resolveCredential(varName, overrideValue, envFile, env) {
  const externalName = varName.replace('CLOUDFLARE_', 'DEPLOYER_CLOUDFLARE_');
  const value = [overrideValue, env[externalName], envFile[varName], env[varName]].find((candidate) => !isBlank(candidate));
  if (isBlank(value)) throw new MissingCredentialError(varName);
  return value;
}

/**
 * Resolves { apiToken, accountId } by precedence: explicit args → package
 * .env → process.env. `env`/`envFile` are injectable for tests; real callers
 * never pass them.
 */
export function resolveAuth(overrides = {}, { env = process.env, envFile = readEnvFile() } = {}) {
  const apiToken = resolveCredential('CLOUDFLARE_API_TOKEN', overrides.apiToken, envFile, env);
  const accountId = resolveCredential('CLOUDFLARE_ACCOUNT_ID', overrides.accountId, envFile, env);
  return { apiToken, accountId };
}

/**
 * Resolves the D1 database holding the sharded-hosting tables
 * (`demo_placements`, `demo_files`, `shard_locks`; schema owned by
 * factory-cli's migrations) with the same precedence as the credentials:
 * explicit arg → package .env → process.env (`DEMOS_D1_DATABASE_ID`).
 */
export function resolveDemosDatabaseId(override, { env = process.env, envFile = readEnvFile() } = {}) {
  return resolveCredential('DEMOS_D1_DATABASE_ID', override, envFile, env);
}
