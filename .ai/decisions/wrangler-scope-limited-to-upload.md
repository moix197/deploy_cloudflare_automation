# Wrangler scoped to upload only; everything else is plain REST

## Context

The initial research treated `wrangler` as the tool for create, list, deploy,
and delete of Pages projects. Cloudflare's direct-upload asset flow
(JWT-gated hash/manifest upload) is undocumented and wrangler-internal —
reimplementing it against the raw REST API is not realistic, so `wrangler`
has to be a dependency for that one operation.

## Decision

`wrangler` is used for **exactly one thing**: the actual file upload
(`wrangler pages deploy`, added in Phase 2). Token verification (Phase 1),
project existence checks, project creation, listing, and deletion (Phase 2/3)
all go through the plain documented Cloudflare REST API via Node's built-in
`fetch` — `src/lib/cloudflareApi.js`.

## Rejected alternative

Using wrangler subcommands (`wrangler pages project list`, `wrangler pages
project create`, `wrangler pages project delete`) for the non-upload
operations too, since wrangler already wraps them.

Rejected because:

- Spawning a child process for a read-only check (does a project exist?) is
  slower and harder to test than mocking a `fetch` call.
- `wrangler pages project list --json` does not include the `subdomain`
  field needed to report the real live URL back to the caller — only the
  REST project GET/POST response has it. Relying on wrangler for listing
  would still require a REST call for the URL, so it doesn't reduce surface
  area.
- Keeping wrangler's footprint to one call site (`runWrangler`, Phase 2)
  means everything else is unit-testable with a mocked `fetch`, consistent
  with this project's testability-first priority (see CLAUDE.md).

## Consequence

`wrangler` remains the one exception to CLAUDE.md's "build our own before
installing" rule, and only for the upload step. Every other Cloudflare
interaction in this package is a plain `cloudflareFetch` call.
