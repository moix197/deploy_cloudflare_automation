# cloudflare-pages-deploy

A standalone Node package whose only job is talking to Cloudflare Pages:
given an already-built static directory and an explicit slug, publish it to
`https://<slug>.pages.dev` and report the real URL back. It does not build
sites and keeps no local state — every result it produces (including the
final URL) is read straight back from Cloudflare's API.

Usable both as a library (for a future monorepo to call directly) and as a
CLI (for AI-driven workflows that need a single machine-parseable JSON
result via `--json`).

## Install

```
pnpm install
```

Requires Node >=22 (uses the built-in `fetch` and test runner — no HTTP
client or test framework dependency). `wrangler` is the main runtime
dependency (plus `blake3-wasm`, the hash wrangler uses, for sharded mode); see [`.ai/decisions/wrangler-scope-limited-to-upload.md`](.ai/decisions/wrangler-scope-limited-to-upload.md)
for why it's scoped to just the file-upload step.

## Manual Setup (Cloudflare Dashboard)

Do this once, by hand, before `check-auth` can succeed against the real API:

1. Go to **Cloudflare Dashboard → My Profile → API Tokens**
   (`https://dash.cloudflare.com/profile/api-tokens`).
2. **Create Token → Create Custom Token.**
3. Under **Permissions**, add exactly:
   - `Account` — `Cloudflare Pages` — `Edit`
   - `Account` — `Account Settings` — `Read` (optional but recommended)
4. Under **Account Resources**, scope to **one specific account**.
5. Create the token and copy it immediately (shown once) — this is
   `CLOUDFLARE_API_TOKEN`.
6. Find your **Account ID** on any site's dashboard Overview page, right
   sidebar — this is `CLOUDFLARE_ACCOUNT_ID`.
7. Copy `.env.example` to `.env` and paste both values in. `.env` is
   gitignored — never commit it.

Note: on a brand-new Cloudflare account, project *creation* is throttled for
the first 48h.

## Usage

### `check-auth`

Resolves credentials (explicit args → package `.env` → `process.env`) and
verifies the token against Cloudflare's real `/user/tokens/verify` endpoint.

```
node bin/cloudflare-pages-deploy.js check-auth
node bin/cloudflare-pages-deploy.js check-auth --json
```

With no credentials configured, it exits non-zero and names the exact
missing variable (`CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`) instead
of crashing. With a set-but-rejected token, it exits non-zero with a message
that distinguishes "token set but Cloudflare rejected it" from "not
configured at all". With valid credentials, it exits 0 and prints the
account id and token status.

### `deploy`

Publishes an already-built static directory to Cloudflare Pages under an
explicit slug. Creates the Pages project first if it doesn't exist yet (see
[`.ai/decisions/no-auto-create-on-deploy.md`](.ai/decisions/no-auto-create-on-deploy.md)),
uploads the directory via `wrangler pages deploy`, then reads the real live
URL back from Cloudflare's API (see
[`.ai/decisions/hostname-read-back-not-constructed.md`](.ai/decisions/hostname-read-back-not-constructed.md)).
Re-running with the same `--slug` is idempotent — it does not error on
"project already exists".

```
node bin/cloudflare-pages-deploy.js deploy --dir <path> --slug <slug>
node bin/cloudflare-pages-deploy.js deploy --dir <path> --slug <slug> --json
```

`--json` output on success:

```json
{ "ok": true, "status": "deployed", "url": "https://<slug>.pages.dev", "slug": "<slug>" }
```

As a library:

```js
import { deploy } from 'cloudflare-pages-deploy';

const { url, status } = await deploy({ dir: '/abs/path/to/site', slug: 'my-app' });
```

`deploy()` also accepts `onStart`/`onProgress`/`onDone`/`onError` hooks so a
consumer can record status without polling.

Every typed error class the package throws (`SlugTakenError`,
`ProjectNotFoundError`, `RateLimitError`, etc. — see the error tables below)
is exported from the package root too, so a consumer can branch on
`instanceof`/`.code` without reaching into `src/errors.js`:

```js
import { deploy, SlugTakenError } from 'cloudflare-pages-deploy';

try {
  await deploy({ dir: '/abs/path', slug: 'my-app' });
} catch (error) {
  if (error instanceof SlugTakenError) {
    // pick a different slug
  }
}
```

Slugs must be 1-58 characters, lowercase letters/digits/dashes only, and
cannot start or end with a dash — this is validated locally before any
network call. Note: whether `<slug>.pages.dev` uniqueness is scoped
per-account or global is undocumented by Cloudflare; community reports
(not confirmed fact) indicate it's global, since `.pages.dev` is a shared
namespace. A taken slug fails outright with `SlugTakenError` — Cloudflare
does not silently suffix it.

Also note the confirmed **100 Pages projects per account** cap (all plans,
"not routinely increased") and the **20,000 files / 25 MiB per file** limit
on the free tier — a directory that exceeds either surfaces wrangler's own
error message verbatim via `WranglerExecutionError`.

#### Error codes

| Error | Meaning |
| --- | --- |
| `INVALID_SLUG` | Slug fails the format rule above |
| `DIRECTORY_NOT_FOUND` | `--dir` doesn't exist or isn't a directory |
| `EMPTY_DIRECTORY` | `--dir` exists but has no files |
| `SLUG_TAKEN` | Project name is taken by a different account — choose another slug |
| `PROJECT_CREATE_ERROR` | Project creation failed for any other reason (e.g. the 100-project cap); carries Cloudflare's real code/message |
| `MISSING_SUBDOMAIN` | Cloudflare returned no subdomain for the project after upload — cannot build a live URL |
| `WRANGLER_EXECUTION_ERROR` | `wrangler pages deploy` exited non-zero; carries its stderr verbatim |
| `MISSING_WRANGLER_ENTRYPOINT` | Resolved wrangler entrypoint (`bin/wrangler.js`) does not exist on disk at the resolved path |
| `RATE_LIMIT` | Cloudflare rate-limited the upload (HTTP 429); not auto-retried — retry later |

### `list`

Lists every Pages project in the account, mapped to a stable shape
(`{name, subdomain, domains, productionBranch}`) rather than Cloudflare's raw
project object.

```
node bin/cloudflare-pages-deploy.js list
node bin/cloudflare-pages-deploy.js list --json
```

`--json` output:

```json
{ "ok": true, "projects": [{ "name": "my-app", "subdomain": "my-app.pages.dev", "domains": ["my-app.pages.dev"], "productionBranch": "main" }], "count": 1 }
```

As a library:

```js
import { listProjects } from 'cloudflare-pages-deploy';

// apiToken/accountId are optional — omit them and listProjects() resolves
// credentials itself (explicit args → .env → process.env). deploy() also
// self-resolves credentials, but it does not accept apiToken/accountId
// overrides the way listProjects()/deleteProject() do.
const projects = await listProjects();
const projectsForOtherAccount = await listProjects({ apiToken, accountId });
```

### `delete`

Deletes a Pages project by slug. Exists because of the confirmed **100
projects per account** cap — throwaway demo/test slugs should be deleted
once they're no longer needed rather than left to accumulate toward it.

```
node bin/cloudflare-pages-deploy.js delete --slug <slug>
node bin/cloudflare-pages-deploy.js delete --slug <slug> --json
```

`--json` output on success:

```json
{ "ok": true, "slug": "<slug>", "status": "deleted" }
```

Deleting a slug that doesn't exist (or was already deleted) fails cleanly
with `PROJECT_NOT_FOUND` — not a crash:

```json
{ "ok": false, "code": "PROJECT_NOT_FOUND", "message": "Cloudflare Pages project \"<slug>\" was not found" }
```

As a library:

```js
import { deleteProject } from 'cloudflare-pages-deploy';

// apiToken/accountId are optional here too — self-resolved when omitted.
await deleteProject({ slug: 'my-app' });
```

#### Error codes (list/delete)

| Error | Meaning |
| --- | --- |
| `PROJECT_NOT_FOUND` | `delete` was called with a slug that doesn't exist in the account |
| `INVALID_SLUG` | `delete` was called with a slug that fails the format rule above |

## Sharded demo hosting (`--sharded`)

The default mode above spends one Pages project per slug, and an account is
capped at 100 projects. Sharded mode hosts many demos in **10 shared
projects** (`wx-demos-01` … `wx-demos-10`): each demo is published under
`/<slug>/` of one shard and served publicly at
`https://<slug>.web-express.com.ar` by the routing Worker in `worker/`.
The default mode is unchanged; sharded mode is opt-in per call.

State lives in factory-cli's D1 database (schema:
factory-cli `migrations/d1/0008_demo_shards.sql` and `0009_shard_deployments.sql`):

| Table | Holds |
| --- | --- |
| `demo_placements(slug, shard, lead_id, file_count, updated_at)` | which shard serves each slug (the Worker reads this) |
| `demo_files(shard, path, hash)` | each shard's current Pages manifest, so a deploy never needs other demos' files |
| `shard_locks(shard, holder, expires_at)` | a 5 min lease per shard serializing manifest read → deploy → write |
| `shard_deployments(shard, url, updated_at)` | each shard's latest deployment URL (`https://<id8>.<shard>.pages.dev`), which the Worker proxies to |

Credentials resolve as explicit args > `DEPLOYER_CLOUDFLARE_API_TOKEN` /
`DEPLOYER_CLOUDFLARE_ACCOUNT_ID` in process.env > package `.env` >
`CLOUDFLARE_*` in process.env (all commands). This lets a parent process
(factory-cli, sharded mode) supply its own token without touching this
package's shared `.env`; with `DEPLOYER_*` unset nothing changes.

Extra configuration: `DEMOS_D1_DATABASE_ID` (package `.env`/env, or
`--d1-database <id>`), and the token needs **D1 Edit** on top of Pages Edit.

### `shards init`

Idempotently creates the 10 shard projects and fails with
`SHARD_SUBDOMAIN_MISMATCH` if any is not served at `<name>.pages.dev` (the
address the Worker proxies to).

```
node bin/cloudflare-pages-deploy.js shards init --json
```

### `deploy --sharded`

```
node bin/cloudflare-pages-deploy.js deploy --dir <path> --slug <slug> --sharded [--lead-id <n>] [--d1-database <id>] --json
```

```json
{ "ok": true, "status": "deployed", "url": "https://wx-demos-03.pages.dev/<slug>/", "slug": "<slug>", "shard": "wx-demos-03", "files": 412, "uploaded": 37,
  "lock": { "requestedAt": "…", "acquiredAt": "…", "releasedAt": "…" } }
```

`url` is the raw shard path (assets referenced from `/` only resolve through
the Worker); the public URL is `https://<slug>.web-express.com.ar`.

Steps: hash every file exactly like `wrangler pages deploy` (blake3 of
base64 contents + extension, 32 hex; `blake3-wasm` is a dependency for this)
→ choose the shard (existing placement wins; otherwise fewest files, skipping
any shard that would pass 18,000 files) → Pages direct upload of this slug
only (upload JWT → check-missing → upload missing → upsert-hashes) → take
the shard lease (retried with backoff up to ~5 min) → merge the stored shard
manifest (this slug's `/<slug>/…` entries replaced, stale ones dropped) →
create the deployment from it → wait (≤60 s) until the new deployment URL
serves → write manifest rows + placement + the shard's deployment URL in one
D1 transaction guarded by the lease → release. `lock` timestamps show when
the lease was requested, acquired and released (a concurrent deploy to the
same shard acquires only after the other released).

### `delete --sharded`

```
node bin/cloudflare-pages-deploy.js delete --slug <slug> --sharded --json
```

Redeploys the slug's shard without `/<slug>/…` and drops its manifest rows
and placement. Unknown slug → `PLACEMENT_NOT_FOUND`.

#### Error codes (sharded)

| Error | Meaning |
| --- | --- |
| `SHARDS_FULL` | No shard has room for this demo under the 18,000-file budget — add shards |
| `SHARD_FILE_LIMIT` | The merged manifest would exceed Pages' 20,000 files |
| `SHARD_LOCK_TIMEOUT` | Another deploy held the shard for over ~5 min |
| `SHARD_LOCK_LOST` | The lease was taken over before the D1 write; nothing was recorded — redeploy |
| `PLACEMENT_CONFLICT` | A concurrent first deploy of the same slug placed it on another shard — rerun |
| `PLACEMENT_NOT_FOUND` | `delete --sharded` for a slug with no placement |
| `SHARD_SUBDOMAIN_MISMATCH` | A shard project is not served at `<name>.pages.dev` |
| `FILE_TOO_LARGE` | A file is over Pages' 25 MiB limit |

### Routing Worker (`worker/`)

`worker/wrangler.toml` routes `*.web-express.com.ar/*` to `worker/src/index.js`,
which maps `<slug>` → the shard's latest deployment URL through the `DB` D1 binding (cached ~15 s,
unknown slugs ~1 min, via the Cache API) and proxies GET/HEAD to
`https://<id8>.<shard>.pages.dev/<slug><path>?<query>` (the `<shard>.pages.dev`
alias only when D1 has no valid deployment URL: the alias can keep serving a
superseded deployment from Pages' edge cache, `s-maxage=604800`), rewriting Pages' own
redirects back to public paths. Any host that is not a placed demo is passed
through with `fetch(request)`; other methods on a demo get 405.

### Rollout (production, in order)

1. Apply factory-cli `migrations/d1/0008_demo_shards.sql` to D1 `web-express` (plain execute, not `migrations apply`): from this repo, `pnpm exec wrangler d1 execute web-express --remote --file ../web_factory/factory-cli/migrations/d1/0008_demo_shards.sql`.
2. Give the deployer token **D1 Edit**; set `DEMOS_D1_DATABASE_ID` (or let factory-cli pass `--d1-database`).
3. `node bin/cloudflare-pages-deploy.js shards init --json`.
4. DNS on `web-express.com.ar`: proxied wildcard `*` record (e.g. `AAAA * 100::`, proxied) so every subdomain reaches Cloudflare.
5. `pnpm exec wrangler deploy --config worker/wrangler.toml` with a token holding Workers Scripts Edit + Workers Routes Edit (zone) + D1.
6. Deploy one demo with `--sharded`, check `https://<slug>.web-express.com.ar`, then set `FACTORY_DEPLOY_MODE=sharded` in factory-cli.

## Development

```
pnpm test
```

Uses Node's built-in test runner (`node --test`) — no test framework
dependency.
