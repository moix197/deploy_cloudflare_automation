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
client or test framework dependency). `wrangler` is the only runtime
dependency; see [`.ai/decisions/wrangler-scope-limited-to-upload.md`](.ai/decisions/wrangler-scope-limited-to-upload.md)
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

## Development

```
pnpm test
```

Uses Node's built-in test runner (`node --test`) — no test framework
dependency.
