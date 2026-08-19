# Ensure-then-deploy: create the project before uploading, never rely on a prompt

## Context

`wrangler pages deploy` will **not** auto-create a missing Pages project when
run non-interactively (no TTY) — it hard-errors instead of prompting. Every
consumer of this package (CLI, future monorepo integration, any AI-driven
automation) runs wrangler non-interactively, so this wall would be hit
independently by each of them unless solved once, here.

## Decision

`deploy()` (`src/lib/deploy.js`) always calls `ensureProject()`
(`src/lib/ensureProject.js`) before invoking `runWrangler()`. `ensureProject`
does a REST `GET` for the project by slug; on 404 it `POST`s a create with
`production_branch: 'main'`. This ordering is not optional or racy — the
upload step never runs until project existence is confirmed or created.

`ensureProject` is also idempotent: if the create call itself fails with
Cloudflare's "slug taken" error (code `8000003`) — which can happen if a
concurrent request from this same account created it first — it re-`GET`s
the project. If the re-`GET` now finds it, that's treated as success (the
concurrent create won the race, but the caller's intent — "this project
should exist" — is satisfied). Only if the re-`GET` still finds nothing does
it throw `SlugTakenError`, meaning the name is genuinely taken elsewhere.

## Rejected alternative

Reimplementing Cloudflare's direct-upload asset flow (JWT-gated hash/
manifest upload) against the raw REST API, to avoid depending on wrangler at
all. Rejected because that flow is undocumented and wrangler-internal —
reimplementing it is not realistic (confirmed during research). Wrangler
remains a dependency for exactly the upload step; see
[`wrangler-scope-limited-to-upload.md`](wrangler-scope-limited-to-upload.md).

## Consequence

Callers of `deploy()` — CLI or library — never need to pre-create a Pages
project by hand, and re-running `deploy()` against the same slug is always
safe (it does not error on "project already exists").
