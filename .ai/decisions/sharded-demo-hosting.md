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
  `<slug>.web-express.com.ar` by proxying to `https://<shard>.pages.dev/<slug>/…`.
- Each shard's manifest is stored in D1 `demo_files` (factory-cli owns the
  schema, migration 0008), so a deploy uploads and hashes only its own slug
  and merges into the stored manifest — no other demo's files needed locally.
- Placement: existing placement wins (demos never move); new slugs go to the
  shard with the fewest files under an 18,000 budget (Pages hard limit 20,000,
  headroom for growth on redeploy).
- Concurrency: a D1 lease per shard (`shard_locks`, atomic upsert-if-expired,
  ~2 min, renewed right before creating the deployment, waited for up to ~5
  min with backoff). The final D1 write embeds the lease as an `EXISTS`
  guard in every statement and re-reads the holder in the same transaction,
  so a writer that lost its lease records nothing (`SHARD_LOCK_LOST`).
- Upload uses the Pages direct-upload REST flow wrangler uses internally
  (upload-token JWT → check-missing → upload → upsert-hashes → multipart
  deployment). Hashes and content types must equal wrangler's byte-for-byte;
  tests evaluate wrangler's own `hashFile` and mime@3 tables from the
  installed bundle, so a wrangler upgrade that changes them fails loudly.

## Rejected

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
- The Worker trusts `demo_placements.shard` only if it matches `wx-demos-NN`.
- Assets' content type comes from a curated subset of mime@3
  (`src/lib/sharded/contentType.js`); unlisted extensions upload as
  `application/octet-stream`.
