# Sharded demo hosting: 10 shared Pages projects + D1 manifest + routing Worker

## Context

One Pages project per demo hits the 100-projects-per-account cap. Pages
deployments are full replacements (each one carries the whole manifest), so
sharing a project between demos means every deploy must know every other
demo's files.

## Decision

Opt-in `--sharded` mode (default mode untouched):

- 10 projects `wx-demos-01..10` (`shards init`, idempotent). A demo lives at
  `/<slug>/` of one shard; the Worker in `worker/` serves it at
  `<slug>.web-express.com.ar` by proxying to the shard's latest deployment URL
  `https://<id8>.<shard>.pages.dev/<slug>/…` (D1 `shard_deployments`, migration
  0009), falling back to the `<shard>.pages.dev` alias only when that row is
  missing or invalid.
- Each shard's manifest is stored in D1 `demo_files` (factory-cli owns the
  schema, migration 0008), so a deploy uploads and hashes only its own slug
  and merges into the stored manifest — no other demo's files needed locally.
- Placement: existing placement wins (demos never move); new slugs go to the
  shard with the fewest files under an 18,000 budget (Pages hard limit 20,000,
  headroom for growth on redeploy).
- Concurrency: a D1 lease per shard (`shard_locks`, atomic upsert-if-expired,
  5 min, renewed before the upsert and before and after creating the deployment,
  waited for up to ~5 min with backoff). The final D1 write embeds the lease as an `EXISTS`
  guard in every statement and re-reads the holder in the same transaction,
  so a writer that lost its lease records nothing (`SHARD_LOCK_LOST`).
- Upload uses the Pages direct-upload REST flow wrangler uses internally
  (upload-token JWT → check-missing → upload → upsert-hashes → multipart
  deployment). Hashes and content types must equal wrangler's byte-for-byte;
  tests evaluate wrangler's own `hashFile` and mime@3 tables from the
  installed bundle, so a wrangler upgrade that changes them fails loudly.

- Why the deployment URL, not the alias: in the rollout test the production
  alias of shards 01/02 kept serving their first deployment from Pages' own
  edge cache (`s-maxage=604800`, `CF-Cache-Status: HIT`, `x-robots-tag:
  noindex`) after a redeploy and a delete; unique deployment URLs were always
  correct (`max-age=0`). Not reproducible on demand and not purgeable from our
  side, so the alias is not trusted. Deployment URLs are immutable, so no
  invalidation is needed: the Worker caches slug → URL for 15 s and a
  redeploy/delete is visible within that (measured: v2 at +7 s, removal at +1 s).
- The deployer waits (≤60 s, best effort) until a new deployment URL serves
  before recording it, since it answers 522 for a few seconds.

## Rejected

- Trusting the `<shard>.pages.dev` alias (stale edge cache above); purging the
  zone (the stale cache is on pages.dev, not our zone).

- More accounts / per-demo projects: account sprawl, same cap per account.
- Rebuilding a shard from all demos' local dirs on every deploy: needs every
  demo checked out on the deploying machine.
- `wrangler pages deploy` of a merged temp dir: same problem (needs all files).

## Constraints it creates

- A demo's root `_headers`/`_redirects`/`functions` are ignored (they would
  only apply at the shard root).
- Uploaded assets are referenced only by the latest shard deployment; a
  manifest row lost from D1 means that file disappears on the next deploy of
  any demo on that shard.
- The Worker trusts `demo_placements.shard` only if it matches `wx-demos-NN`,
  and a `shard_deployments.url` only if it is `https://<8 hex>.<that shard>.pages.dev`.
- An unknown or removed slug passes through to the wildcard DNS placeholder
  origin (`AAAA 100::`), so it answers 522, not 404.
- The Worker passes requests through when the D1 lookup throws (not cached) and serves `/<slug>/404.html` with status 404 for a shard 404 when it exists.
- Assets' content type comes from a curated subset of mime@3
  (`src/lib/sharded/contentType.js`); unlisted extensions upload as
  `application/octet-stream`.
- `resolveAuth` precedence: explicit args > `DEPLOYER_CLOUDFLARE_API_TOKEN`/
  `DEPLOYER_CLOUDFLARE_ACCOUNT_ID` (process.env) > package `.env` >
  `CLOUDFLARE_*` (process.env). Why: the package `.env` is shared with another
  project and must stay unchanged, yet it outranks process.env, so a parent
  (factory-cli) could not supply its own token. With `DEPLOYER_*` unset the
  chain is identical to before for every command.
