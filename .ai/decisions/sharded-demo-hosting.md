# Sharded demo hosting: 10 shared Pages projects + local manifests + D1 registry + routing Worker

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
- Each live demo's manifest is a file in this repo, committed to git:
  `state/manifests/<shard>/<slug>.json` = `{slug, shard, leadId, fileCount,
  fingerprint, deployedAt, deploymentUrl, files: {"/<slug>/<path>": hash}}`
  (`src/lib/sharded/manifestStore.js`). It is a snapshot of what is LIVE,
  written only after the deployment and the D1 commit succeeded, then
  auto-committed (best effort: `git add -A state/manifests` + `git commit --
  state/manifests` on whatever branch the checkout is on; never pushed; a
  failed commit does not fail the deploy, the file on disk is what counts).
  `fingerprint` = sha256 of the sorted `path\thash` lines. D1 is only the
  registry: `demo_placements` (+ `fingerprint`, migration 0014; `file_count`;
  `updated_at` = deployed_at), `shard_deployments`, `shard_locks`. A deploy
  still uploads and hashes only its own slug — no other demo's files needed.
- Placement: existing placement wins (demos never move); new slugs go to the
  shard with the fewest files under an 18,000 budget (Pages hard limit 20,000,
  headroom for growth on redeploy).
- Concurrency: a D1 lease per shard (`shard_locks`, atomic upsert-if-expired,
  5 min, renewed before the upsert and before and after creating the deployment,
  waited for up to ~5 min with backoff). The final D1 write embeds the lease as an `EXISTS`
  guard in every statement and re-reads the holder in the same transaction,
  so a writer that lost its lease records nothing (`SHARD_LOCK_LOST`).
- Deploy of slug A to shard S, under S's lease: read S's placements from D1,
  load every OTHER slug's local manifest and verify it (file present, its
  files hash to its own `fingerprint`, all paths under `/<slug>/`,
  `fingerprint` and `deployedAt` equal D1's `fingerprint` and `updated_at`);
  any problem aborts with `SHARD_STATE_MISMATCH` listing every bad slug
  (`--json` error `details: {shard, stale: [{slug, leadId, problem}]}`),
  before anything is deployed. Then merge A's new files, create the
  deployment, commit placement (+ fingerprint) + `shard_deployments` (2 rows,
  lease-guarded), write A's file. Delete: same verification, redeploy
  without A, delete its placement, remove its file.
- Why local files (2026-11-15): D1 free tier caps rows written at 100k/day;
  `demo_files` cost one row per file (~1,215 rows per deploy before the
  delta-write fix 5000f03, still hundreds on a rebuild). Now a deploy writes
  2 registry rows + the lease's own rows (acquire, 4 renewals, release:
  ~6 single-row writes). The owner is on the free tier for good; paid plans
  are not an option.
- Why `updated_at` is checked too: a deploy that did not write this
  machine's file (another machine, or pre-manifest code during the switch)
  changes `updated_at` even when it cannot change `fingerprint`.
- Recovery from `SHARD_STATE_MISMATCH` (owner decision): rebuild + redeploy
  the affected demo. Never hand-edit a manifest or a fingerprint to make a
  deploy pass: the shard would be republished without that demo's real
  files. Caveat: the redeployed demo is excluded from the check, but every
  other slug on the shard still has to verify, so with two stale demos on one
  shard neither could be redeployed (deadlock).
- `--skip-stale` (owner decision 2026-11-17, opt-in; default unchanged): under
  the same lease, stale/missing neighbours named in
  `--skip-stale=<slug,...>` are left out of the deployment instead of
  aborting; a stale neighbour not in the list still aborts (listing only
  those), so a slug that went stale after the caller judged the first error
  is never taken offline unseen. No bare flag form. Pages deploys are full replacements, so they go
  offline (Worker 404). Their placement is kept (same shard, file budget
  reserved) and, in the same lease-guarded D1 transaction, their
  `fingerprint` is set to the sentinel `'offline'` (`OFFLINE_FINGERPRINT`);
  `updated_at` is untouched (factory's reconcile reads it as a deploy). An
  offline placement is not a neighbour: never verified, never merged, never
  blocks a deploy. Redeploying that slug writes a real fingerprint and it is a
  verified neighbour again. Deploy/delete JSON returns `skipped: [{slug,
  leadId, problem}]`. Why a sentinel and not NULL: NULL keeps meaning "no
  fingerprint recorded" (still a mismatch), and no migration is needed.
  factory-cli decides when to pass it (stage-based, see its
  `.ai/data/demo-shards.md`).
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
- Uploaded assets are referenced only by the latest shard deployment, so
  the local manifests are the only record of what each shard serves. Deploys
  must run from this checkout (`state/manifests` resolved from the package
  root, never cwd); another machine or worktree without current files gets
  `SHARD_STATE_MISMATCH`, never a silent drop.
- D1 is only the registry (`demo_placements`, `shard_locks`,
  `shard_deployments`). `demo_files` (0008) is unused by all code (the
  one-time export to local manifests ran 2026-11-15 and was removed); it stays
  in prod until the owner applies factory-cli `0015_drop_demo_files.sql`,
  which is safe to apply any time.
- The Worker trusts `demo_placements.shard` only if it matches `wx-demos-NN`,
  and a `shard_deployments.url` only if it is `https://<8 hex>.<that shard>.pages.dev`.
- An unknown or removed slug gets a branded 404 page (`worker/src/notFound.js`).
  Real subdomains must be listed in the `PASSTHROUGH_SUBDOMAINS` wrangler var
  (`www` is always included) or they get that 404 too; anything that is not a
  single slug label still passes through to the `AAAA 100::` placeholder (522).
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

## Operations (production state 2026-11-10)

- Deploy: `deploy --dir <d> --slug <s> --sharded --d1-database <id> --lead-id <n> --json`; check `https://<slug>.web-express.com.ar` (a redeploy shows in seconds; the `<shard>.pages.dev` alias can be stale, never verify through it).
- Remove: `delete --slug <s> --sharded --json` (shard redeployed without the slug, placement dropped, Worker 404s within seconds). Plain `delete --slug <s>` is for legacy per-demo projects.
- Limits: 18,000 files per shard placement budget, 20,000 Pages cap, 25 MiB per file; `SHARDS_FULL` means add shards.
- Tokens: needs Pages Edit + D1 Edit (factory passes its own as `DEPLOYER_CLOUDFLARE_*`); deploying the Worker needs Workers Scripts Edit + zone Workers Routes Edit + D1. Shared `.env` stays untouched.
- Rollback: per demo, deploy it without `--sharded` (legacy project) then `delete --sharded` the placement; Worker via `wrangler rollback` or redeploying an earlier `worker/`. Migrations 0008/0009 only add tables, 0014 only adds a column.
- Worker var `PASSTHROUGH_SUBDOMAINS` lists real subdomains (add one with every new DNS record and redeploy the Worker), or they get the branded 404.
- Old per-demo projects were deleted except `cucchiettiboats` and `rosarioagroindustrial` (still `*.pages.dev` until redeployed sharded).
