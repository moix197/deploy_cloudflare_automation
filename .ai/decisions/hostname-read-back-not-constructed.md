# The deployed URL is always read back from the API, never assumed as `<slug>.pages.dev`

## Context

It would be simplest for `deploy()` to just return `` `https://${slug}.pages.dev` ``
after a successful upload. Two undocumented behaviors make that unsafe:

- Whether `.pages.dev` name uniqueness is scoped per-account or global is
  undocumented by Cloudflare. Community reports
  (github.com/cloudflare/workers-sdk/issues/3527) indicate it's global,
  since `.pages.dev` is a shared namespace — but this is not a confirmed
  fact.
- `wrangler pages project list --json` does not include a `subdomain` field
  (only Project Name, Project Domains, Git Provider, Last Modified) — so
  even wrangler's own output can't be trusted as the URL source.

## Decision

After `ensureProject` and the wrangler upload both succeed, `deploy()`
(`src/lib/deploy.js`) makes one more REST call — `GET
/accounts/{id}/pages/projects/{slug}` — and reads the real `subdomain` field
back from Cloudflare's response as the returned `url`. This is a
confirmation step, not a collision-recovery mechanism: a taken name already
fails hard at `ensureProject` time (see
[`no-auto-create-on-deploy.md`](no-auto-create-on-deploy.md)) via the
verified, non-recoverable `8000003` API error — Cloudflare does not silently
suffix a taken name at the API level (that behavior is dashboard-UX-only).
So by the time this readback runs, the project name is already confirmed to
be exactly `slug`, and the readback exists purely so the returned URL can
never drift from what Cloudflare actually serves.

## Rejected alternative

Constructing the URL client-side as `` `https://${slug}.pages.dev` ``.
Rejected because it bakes in an assumption about a domain suffix Cloudflare
could change, and gives a caller no signal if Cloudflare ever did return a
different subdomain for a given project name.

## Consequence

The one extra REST call after deploy is a small, cheap price for the URL
this package returns being guaranteed to be genuinely live, sourced directly
from Cloudflare rather than string-built.
