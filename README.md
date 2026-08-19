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

## Development

```
pnpm test
```

Uses Node's built-in test runner (`node --test`) — no test framework
dependency.
