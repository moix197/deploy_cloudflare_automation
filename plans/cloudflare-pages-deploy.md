# Plan: Cloudflare Pages Deploy Package

**Created:** 2026-08-18
**Branch:** `cloudflare-pages-deploy`
**Status:** complete

## Context

`deploy_cloudflare_automation` is currently an empty scaffold (no `package.json`,
no `.git`, no code — only `.ai/`, `.claude/skills/`, `CLAUDE.md`, and this
plan's research). The goal is a standalone, reusable Node package whose only
job is talking to Cloudflare Pages: given an already-built static directory
and an explicit slug, publish it to `https://<slug>.pages.dev` and report the
real URL back. It does not build sites, does not know about Docker/Grav/pnpm
site tooling, and keeps no local state — it is a pure Cloudflare adapter meant
to be consumed both as a library (hooks for a future monorepo to record
status) and as a thin CLI (for AI-driven workflows that need a single
machine-parseable JSON result).

The core problem this package exists to solve: `wrangler pages deploy` will
**not** auto-create a missing Pages project when run non-interactively (no
TTY) — it hard-errors instead of prompting. Every consumer of this package
would hit that wall independently unless the create-then-deploy sequencing is
solved once, here.

## Risk: medium

Well-documented mechanism (wrangler direct-upload + Cloudflare REST API), but
two things keep it above "low": (1) direct-upload rate limits are
undocumented, so 429 handling is defensive-by-design rather than
spec-verified, and (2) whether `pages.dev` name uniqueness is scoped
per-account or globally is undocumented (community-reported as global) —
verified fact, however: a taken name **fails project creation outright**
(API error code `8000003`), it is **not** silently suffixed by the API (that
suggestion behavior is dashboard-UX-only). The design surfaces a clear
"choose a different slug" error on that failure rather than trying to recover
a mutated hostname.

## Dependencies & Risks

- **External dependency:** `wrangler@4` (devDependency **and** runtime
  dependency — it's the invoked binary). This is the one exception CLAUDE.md's
  "build our own before installing" rule explicitly permits, because
  Cloudflare's direct-upload asset flow (JWT-gated hash/manifest upload) is
  undocumented and wrangler-internal — reimplementing it against the REST API
  is not realistic (confirmed in research).
- **Design refinement vs. the research doc:** the research's distilled
  decisions treat wrangler as the tool for create/list/deploy. This plan
  narrows that further — wrangler is used **only** for the actual file
  upload (`wrangler pages deploy`), because that's the one operation with no
  documented REST equivalent. Token verification, project existence checks,
  project creation, listing, and deletion all go through the plain
  documented Cloudflare REST API via native `fetch` (Node 22 has it built
  in, zero extra dependency). This is more testable (REST calls mock
  trivially; spawning child processes for read-only operations does not) and
  keeps wrangler's surface area to exactly the one thing only it can do.
  Recorded as a decision in `.ai/decisions/` (see Knowledge Base Impact).
- **Wrangler config-file discovery gotcha:** wrangler walks *up* from its
  `--cwd` looking for `wrangler.toml`/`wrangler.jsonc`. A stray config in an
  unrelated ancestor directory of the site being deployed could silently
  hijack the run. Mitigation: spawn wrangler with `cwd` set to **this
  package's own directory** (guaranteed config-free, since this package will
  never ship one) and pass the target site directory as an **absolute path**
  positional argument, so config discovery and asset-directory resolution
  are fully decoupled.
- **Name collision — verified:** creating a project whose name is already
  taken **fails outright** (API error code `8000003`); Cloudflare does not
  silently append random characters at the API level (that only happens as a
  suggestion in the dashboard UI). `ensureProject` must treat "name taken by
  someone else" as a distinct, clearly-reported error telling the caller to
  pick a different slug — it is not a create-then-continue case.
- **Name uniqueness scope — undocumented.** Cloudflare publishes nothing on
  whether `<name>.pages.dev` uniqueness is per-account or global. Community
  reports (github.com/cloudflare/workers-sdk/issues/3527) indicate it's
  global, since `.pages.dev` is a shared namespace. Treat as
  community-reported, not confirmed fact, in README/error messaging.
  Reading the real `subdomain` back from the API after create/deploy is still
  correct practice — it's just a confirmation step now, not collision
  recovery.
- **Account limits — confirmed:** 100 Pages projects per account on **all
  plans**, and Cloudflare states this cap is "not routinely increased." Also
  20,000 files / 25 MiB per file on the free tier. Worth surfacing to the
  user in README since this package is meant for throwaway demo sites that
  accumulate — hence `deleteProject` is in scope for v1, not deferred.
- **New-account throttle — confirmed:** project *creation* (not deployment)
  is throttled during an account's first 48h. A brand-new account/token may
  hit this during Phase 1/2 testing — noted in Manual Setup.
- **Order-sensitive:** ensure-project-exists MUST complete (create or
  confirm-exists) before the upload step runs; the package must never call
  `wrangler pages deploy` speculatively and rely on an interactive prompt.
- **One credential set, two call paths — confirmed no dual-auth risk.**
  `resolveAuth()` runs exactly once per `deploy()`/`listProjects()`/
  `deleteProject()` call. The resulting `{apiToken, accountId}` is used
  directly as the REST `Authorization: Bearer` header AND passed through as
  `runWrangler`'s `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` env vars —
  wrangler recognizes exactly those two variable names for non-interactive
  auth (confirmed in research), so this is genuinely one token authenticating
  both paths, never two separately-resolved credentials.
- **Cut for over-engineering — no retry/backoff framework.** An earlier draft
  had `deploy.js` auto-retry once with backoff on `RateLimitError`. Direct-
  upload rate limits are undocumented (no known window, no known threshold),
  so any backoff constant would be a guess dressed up as a mechanism. Cut it:
  `RateLimitError` now propagates straight to the caller (CLI prints it,
  `onError` fires) with a message suggesting a retry. A real retry policy
  belongs in the future monorepo consumer, which has visibility into actual
  429 frequency — this package's job is to report the failure clearly, not
  to guess at recovery.
- **Cut for over-engineering — no `--branch` config surface.** The locked
  decisions fix the production branch at `main` for both project creation
  and deploy; nothing in scope needs a different value. `deploy()` and the
  CLI do not expose a branch parameter/flag.
- **File-count / file-size limits — deliberately not pre-validated.**
  Re-implementing a recursive walk to check the 20,000-file / 25 MiB-per-file
  ceiling before invoking wrangler would duplicate validation wrangler
  already does, and would drift silently if Cloudflare changes the numbers.
  The package instead surfaces wrangler's own failure message verbatim via
  `WranglerExecutionError` when a directory exceeds a limit.
- **100-project-per-account cap — no invented error class.** Cloudflare
  publishes no distinct error code for "project limit reached," so
  `ensureProject` does not guess at one. Any project-create failure other
  than the confirmed `8000003` (slug taken) surfaces as `ProjectCreateError`
  carrying Cloudflare's real code/message — which, for the cap case, will
  say so directly. README documents the 100-project limit so users
  recognize the message when they see it.

## Manual Setup (Cloudflare Dashboard) — required before Phase 1 can be verified end-to-end

You (the user) must do this once, by hand, in the Cloudflare dashboard.
Phase 1's steps will pause and ask for these values.

1. Go to **Cloudflare Dashboard → My Profile → API Tokens**
   (`https://dash.cloudflare.com/profile/api-tokens`).
2. Click **Create Token → Create Custom Token**.
3. Under **Permissions**, add exactly:
   - `Account` — `Cloudflare Pages` — `Edit`
   - `Account` — `Account Settings` — `Read` (optional but recommended — lets
     the package auto-verify which account the token belongs to)
4. Under **Account Resources**, scope to **one specific account** (not "All
   accounts").
5. Create the token, copy it immediately (shown once). This is
   `CLOUDFLARE_API_TOKEN`.
6. Find your **Account ID**: any domain's Cloudflare dashboard Overview page,
   right sidebar, "Account ID" — or `dash.cloudflare.com` → any site →
   copy from the URL / API section. This is `CLOUDFLARE_ACCOUNT_ID`.
7. Do **not** commit either value. Phase 1 creates a gitignored `.env` for
   local use; paste both there as `CLOUDFLARE_API_TOKEN=...` and
   `CLOUDFLARE_ACCOUNT_ID=...`.
8. Note: if your Cloudflare account is brand new, project *creation* is
   throttled for the first 48h — if Phase 2's real-deploy verification fails
   with a creation error on a fresh account, this is the likely cause.

## Phases

### Phase 0: Initialize git

**Deviation from the plan-sequential default, stated explicitly:** the format
spec's Phase 0 default is `git worktree add`. This plan skips the worktree
step — there is no concurrent work happening on this repo, no other branch in
flight to isolate from, and a single-developer greenfield package gets zero
benefit from a second checkout directory, only extra directory-juggling. That
is exactly the kind of process overhead "do not over-engineer this" rules
out. **Git itself is kept**, because it is a genuine prerequisite the plan
actually depends on: the format's "one commit per phase" convention requires
a repo to commit into, and Phase 4's "confirm no `.env` was committed" check
requires git history to exist. So: init + branch, no worktree.

**Steps:**

- [x] Confirm branch name (`cloudflare-pages-deploy`) and base ref (`main`,
      created fresh) with the user
- [x] `git init -b main` in `C:\proyectos\web-express\deploy_cloudflare_automation`
- [x] Add a root `.gitignore` (`node_modules/`, `.env`, `*.log`) and commit
      the existing scaffold (`.ai/`, `.claude/`, `CLAUDE.md`, `plans/`) as an
      initial commit on `main`
- [x] `git checkout -b cloudflare-pages-deploy`
- [x] Verify the branch is active (`git branch --show-current` → `cloudflare-pages-deploy`)

---

### Phase 1: Package scaffold + credential resolution

**Risk:** low
**Mode:** hil <!-- requires the user to create the Cloudflare API token in the dashboard and paste it into .env before this phase's verification can run -->
**Type:** backend
**Success criteria:** Running `node bin/cloudflare-pages-deploy.js check-auth`
with no credentials set prints a precise, actionable error naming exactly
which env var is missing (not a generic crash). After the user completes the
Manual Setup section and populates `.env`, the same command calls Cloudflare's
real token-verification endpoint and prints the resolved account id and token
status. This is the allowed "infra prerequisite" exception phase — it has no
deploy-facing feature yet, but it ends in something genuinely runnable and
verifiable against the real Cloudflare API, not just scaffolding.
**Acid test:** after this phase, the user can independently diagnose "is my
Cloudflare credential wired up correctly" — a real, standalone capability
(self-service credential debugging), not a disguised config layer — and the
exact `resolveAuth`/`cloudflareApi` code this exercises is reused verbatim by
Phase 2, so nothing here is throwaway scaffolding.
**Commit message:** `feat: scaffold cloudflare-pages-deploy package with credential resolution and check-auth CLI`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `package.json` | name `cloudflare-pages-deploy`, `type: module`, `engines.node >=22`, `bin`, `scripts.test`, `dependencies.wrangler ^4.124.0` |
| create | `.gitignore` | `node_modules/`, `.env`, `*.log` (may already exist from Phase 0 — extend, don't duplicate) |
| create | `.env.example` | `CLOUDFLARE_API_TOKEN=` / `CLOUDFLARE_ACCOUNT_ID=` with comments |
| create | `src/errors.js` | Base `CliError` class with `.code`, plus `MissingCredentialError` (var not set) and `InvalidCredentialError` (var set but Cloudflare rejects it — distinct message, so a typo'd token doesn't look like a missing one) |
| create | `src/auth/resolveAuth.js` | resolves `{ apiToken, accountId }` by precedence: explicit args → package `.env` → `process.env`; throws `MissingCredentialError` naming the exact missing var |
| create | `src/lib/cloudflareApi.js` | tiny REST client: `cloudflareFetch(path, opts)` — base URL, `Authorization: Bearer`, parses Cloudflare's `{success, errors, result}` envelope, throws typed errors on `success: false`; `verifyToken()` calling `GET /user/tokens/verify` |
| create | `bin/cloudflare-pages-deploy.js` | thin executable shim (`#!/usr/bin/env node`), only requires and invokes `src/cli/cli.js` |
| create | `src/cli/cli.js` | minimal arg parsing + command dispatch table; wires up `check-auth` only for now; shared `--json` output helper (~30 lines) |
| create | `src/cli/commands/checkAuth.js` | calls `resolveAuth()` then `verifyToken()`; a set-but-rejected token surfaces `InvalidCredentialError` ("token set but Cloudflare rejected it") distinctly from a missing var; prints human or `--json` result |
| create | `README.md` | package purpose, install (`pnpm install`), Manual Setup pointer, `check-auth` usage |
| modify | `.ai/index.md` | add module rows: `auth/resolveAuth`, `lib/cloudflareApi`, `cli` |
| create | `.ai/decisions/wrangler-scope-limited-to-upload.md` | why wrangler is used only for the upload step, REST for everything else |

**Steps:**

- [x] `pnpm init` and hand-edit `package.json` fields per file table
- [x] `pnpm add -D wrangler@4` (pins to the 4.x line; devDependency since it's a build/deploy-time tool, but listed under `dependencies` too is wrong — keep it a single `dependencies` entry since consumers of this package need it at runtime to actually deploy, not just during this package's own dev)
- [x] Implement `src/errors.js` (`CliError`, `MissingCredentialError`)
- [x] Implement `src/auth/resolveAuth.js` with the explicit-args → `.env` → `process.env` precedence
- [x] Implement `src/lib/cloudflareApi.js` (`cloudflareFetch`, `verifyToken`)
- [x] Implement `bin/cloudflare-pages-deploy.js`, `src/cli/cli.js`, `src/cli/commands/checkAuth.js`
- [x] Write `.env.example` and `README.md` setup section
- [x] Run `node bin/cloudflare-pages-deploy.js check-auth` with no env vars set — confirm it fails with a named-variable error, not a stack trace
- [x] **STOP — hand off to user:** complete the "Manual Setup" section above, paste real values into `.env`
- [x] Re-run `check-auth` with `.env` populated — confirm it prints the account id and "token valid"
- [x] Update `.ai/index.md` and add `.ai/decisions/wrangler-scope-limited-to-upload.md`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/auth/resolveAuth.test.js` | precedence order (args beat `.env` beat `process.env`); missing-var error names the correct variable for each of the two required vars |
| create | `src/cli/commands/checkAuth.test.js` | mocked `verifyToken`: valid → prints account id; Cloudflare rejects the token → `InvalidCredentialError`, message distinct from the missing-var case |
| create | `src/lib/cloudflareApi.test.js` | `cloudflareFetch` with mocked global `fetch`: success envelope unwraps `result`; `success:false` envelope throws a typed error carrying Cloudflare's error code/message; non-2xx HTTP surfaces distinctly from a Cloudflare-level API error |

**Verification:**

- [x] Automated tests pass: `pnpm test`
- [x] `node bin/cloudflare-pages-deploy.js check-auth` (no env) → exits non-zero, message names `CLOUDFLARE_API_TOKEN` (or whichever is actually missing) — not a stack trace
- [x] `node bin/cloudflare-pages-deploy.js check-auth` (real `.env` from Manual Setup) → exits 0, prints the real account id back from Cloudflare's `/user/tokens/verify`, confirming the token is genuinely valid against the live API

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] ~~Reviewer handoff prompt emitted in a fenced code block~~ (n/a — superseded by `/execute-prd` subagent dispatch)
- [x] ~~Orchestrator cleared context (`/clear`) and pasted the handoff prompt~~ (n/a — same reason)
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: scaffold cloudflare-pages-deploy package with credential resolution and check-auth CLI`
- [x] Phase marked complete

---

### Phase 2: Deploy — the money slice

**Risk:** medium
**Mode:** afk <!-- credentials already resolved from Phase 1's .env; no further dashboard interaction needed to execute or verify this phase -->
**Type:** backend
**Success criteria:** Running `cloudflare-pages-deploy deploy --dir <real-built-dir> --slug <test-slug>` against the real Cloudflare account creates the Pages project if it doesn't exist, uploads the directory, and returns the real live `https://<test-slug>.pages.dev` URL (read back from the API, not assumed) — fetched by curl/browser and confirmed to actually serve the deployed content. Re-running the same command against the same slug succeeds idempotently (does not error on "project already exists").
**Commit message:** `feat: add deploy command — create-if-missing project then direct upload to Cloudflare Pages`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `src/lib/validate.js` | `validateSlug(slug)` — 1-58 chars, lowercase, digits and dashes only, cannot start or end with a dash (`/^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$|^[a-z0-9]$/`); rules cited as semi-official (surfaced via API error `8000003`, not documented in prose, no published reserved-name list) — validated client-side before any network call for a fast, precise error. `validateDir(dir)` (exists, is a directory, non-empty) — both throw typed errors |
| create | `src/lib/ensureProject.js` | `ensureProject({ slug, apiToken, accountId })`: `GET` project by name; on 404 → `POST` create with `production_branch: 'main'` (hardcoded — see note below); tolerates a concurrent "already exists *for this same account*" response as success (idempotent); a taken-by-someone-else name (create fails, error `8000003`) surfaces as a distinct `SlugTakenError` telling the caller to choose a different slug — **not** treated as recoverable; any other create failure (including a reached 100-project cap, for which Cloudflare has no documented distinct error code) surfaces as `ProjectCreateError` carrying Cloudflare's own error code/message verbatim, so the account cap is diagnosable from the real API message rather than guessed at |
| create | `src/lib/runWrangler.js` | spawns the local `wrangler` binary (never `npx`), `cwd` = this package's own directory, env = `{ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false' }` — the exact same `{apiToken, accountId}` pair `deploy.js` already resolved once via `resolveAuth()`, passed through as env rather than re-resolved, so there is exactly one credential-resolution path for both the REST calls and wrangler; no TTY; captures stdout/stderr; maps non-zero exit + 429-shaped stderr to `RateLimitError`, other non-zero exits to `WranglerExecutionError` with captured stderr attached verbatim. **Deliberately does not pre-validate file count (20,000) or per-file size (25 MiB)** — re-implementing a recursive directory walk to enforce limits Cloudflare already enforces natively would duplicate wrangler's own validation and drift when limits change; instead `WranglerExecutionError.message` includes wrangler's real stderr, which names the offending limit directly. Used only for the actual upload — never for reading back the URL |
| create | `src/lib/deploy.js` | orchestrator: `resolveAuth()` once → `validateSlug` → `validateDir` → `onStart` hook → `ensureProject` → `onProgress('uploading')` hook → `runWrangler(['pages','deploy', absoluteDir, '--project-name', slug, '--branch', 'main', '--commit-dirty=true'])` (branch is always the literal `'main'`, matching the `production_branch` `ensureProject` created with — not configurable, see `deploy.js`'s CLI command entry below for why) → on `RateLimitError`, surface it directly to the caller rather than auto-retrying (see Dependencies & Risks: cut for over-engineering) → **REST** `GET /accounts/{id}/pages/projects/{slug}` readback for the authoritative `subdomain` field (confirmation, not recovery) → `onDone` hook → return `{ url, slug, projectName, status: 'deployed' }`; `onError` hook on any thrown error before rethrow. **Implementation note:** `wrangler pages project list --json` does NOT include `subdomain` (only Project Name, Project Domains, Git Provider, Last Modified) — the URL must come from the REST project GET/POST response, not from parsing wrangler's list output |
| create | `src/index.js` | public API entry: `export { deploy } from './lib/deploy.js'` (barrel, extended in Phase 3) |
| create | `src/cli/commands/deploy.js` | parses `--dir`, `--slug`, `--json`; calls `deploy()`; formats result. **No `--branch` flag** — cut for over-engineering: the locked decisions fix production branch at `main` for both create and deploy, nothing in scope needs a different value, and exposing it would be config surface nobody asked for |
| modify | `src/cli/cli.js` | register `deploy` command |
| modify | `src/errors.js` | add `InvalidSlugError`, `DirectoryNotFoundError`, `EmptyDirectoryError`, `WranglerExecutionError`, `RateLimitError`, `SlugTakenError`, `ProjectCreateError` |
| modify | `README.md` | document `deploy()` API and CLI usage, error codes table, note on undocumented global-vs-per-account name scope |
| create | `.ai/decisions/no-auto-create-on-deploy.md` | the core problem (non-interactive wrangler won't create projects) and the ensure-then-deploy solution |
| create | `.ai/decisions/hostname-read-back-not-constructed.md` | why the URL is always confirmed by REST readback rather than assumed as `<slug>.pages.dev`, and why a taken name is a hard error, not a suffix-recovery case |

**Steps:**

- [x] Implement `src/lib/validate.js`
- [x] Implement `src/lib/ensureProject.js` (idempotent create)
- [x] Implement `src/lib/runWrangler.js` (spawn wrapper, cwd/env control, 429 detection)
- [x] Implement `src/lib/deploy.js` orchestrator with `onStart`/`onProgress`/`onDone`/`onError` hooks (no retry logic — 429s surface directly, see Dependencies & Risks)
- [x] Implement `src/index.js`, `src/cli/commands/deploy.js`, wire into `src/cli/cli.js`
- [x] Add new error classes to `src/errors.js`
- [x] Create a throwaway local test directory (single `index.html`) in the scratchpad
- [x] Run `cloudflare-pages-deploy deploy --dir <scratchpad-dir> --slug <test-slug> --json` against the real account
- [x] Re-run the identical command a second time — confirm no "already exists" error surfaces
- [x] Update README and `.ai/decisions/`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/lib/validate.test.js` | slug: valid/invalid chars, length boundary, double-dash, leading/trailing dash; dir: missing path, path is a file not a dir, empty dir |
| create | `src/lib/ensureProject.test.js` | mocked `cloudflareApi`: not-found → create called; found (same account) → create skipped; concurrent same-account "already exists" → resolves without throwing; create fails with error `8000003` (name taken) → throws `SlugTakenError`, not treated as recoverable; create fails with any other Cloudflare error (stand-in for the 100-project-cap case) → throws `ProjectCreateError` carrying the original code/message |
| create | `src/lib/runWrangler.test.js` | mocked `child_process.spawn`: exit 0 resolves with stdout; non-zero exit with 429-shaped stderr → `RateLimitError`; other non-zero exit (including a stand-in for an over-limit-files/size message) → `WranglerExecutionError` carrying the real stderr text verbatim; confirms `cwd` is this package's directory and the asset path arg is absolute |
| create | `src/lib/deploy.test.js` | orchestration with all above mocked: hooks fire in order (`onStart`→`onProgress`→`onDone`, or `onError` on failure); a `RateLimitError` from `runWrangler` propagates to the caller (and to `onError`) rather than being silently retried; returned object shape `{url, slug, projectName, status}`; confirms `resolveAuth()` is called once and the same token/accountId reach both `ensureProject` and `runWrangler` |

**Verification:**

- [x] Automated tests pass: `pnpm test`
- [x] Real deploy: `cloudflare-pages-deploy deploy --dir <scratchpad-dir> --slug <test-slug> --json` → JSON `status: "deployed"` with a `url`
- [x] `curl -s -o /dev/null -w "%{http_code}" <returned-url>` → `200`, and response body contains the known `index.html` marker text (Git Bash `curl` or PowerShell `(Invoke-WebRequest <url>).StatusCode`, either works on this Windows box)
- [x] Idempotency: re-running the exact same command does not error
- [x] Error-path spot check: run `deploy --dir <missing-path> --slug <test-slug>` and `deploy --dir <scratchpad-dir> --slug "Invalid_Slug!"` — confirm `DirectoryNotFoundError` / `InvalidSlugError` with clear messages, not stack traces, and neither call reaches the network

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] ~~Reviewer handoff prompt emitted in a fenced code block~~ (n/a — superseded by `/execute-prd` subagent dispatch)
- [x] ~~Orchestrator cleared context (`/clear`) and pasted the handoff prompt~~ (n/a — same reason)
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: add deploy command — create-if-missing project then direct upload to Cloudflare Pages`
- [x] Phase marked complete

---

### Phase 3: List and delete projects

**Risk:** low
**Mode:** afk <!-- credentials already resolved; uses the Phase 2 test project as its own real target, no new dashboard step -->
**Type:** backend
**Success criteria:** `cloudflare-pages-deploy list` shows the real project(s) in the account, including the one created in Phase 2. `cloudflare-pages-deploy delete --slug <test-slug>` removes it from Cloudflare for real, and a subsequent `list` no longer shows it — closing the loop on the "throwaway demo projects accumulate toward the 100-project cap" risk noted above.
**Commit message:** `feat: add listProjects and deleteProject operations`

**File changes:**
| Action | File | What changes |
|---|---|---|
| create | `src/lib/listProjects.js` | `listProjects({ accountId })` → `GET /accounts/{id}/pages/projects`, maps to `{ name, subdomain, domains, productionBranch }[]` |
| create | `src/lib/deleteProject.js` | `deleteProject({ slug, accountId })` → `DELETE /accounts/{id}/pages/projects/{slug}`; maps a 404 to a typed `ProjectNotFoundError` rather than a raw HTTP error |
| modify | `src/index.js` | export `listProjects`, `deleteProject` |
| create | `src/cli/commands/list.js` | calls `listProjects()`, table or `--json` output |
| create | `src/cli/commands/delete.js` | parses `--slug`, calls `deleteProject()`, confirms result |
| modify | `src/cli/cli.js` | register `list` and `delete` commands |
| modify | `src/errors.js` | add `ProjectNotFoundError` |
| modify | `README.md` | document `list` / `delete` CLI + API, note the 100-project account limit as the reason `delete` exists |
| modify | `.ai/index.md` | add module rows: `lib/listProjects`, `lib/deleteProject` |

**Steps:**

- [x] Implement `src/lib/listProjects.js`
- [x] Implement `src/lib/deleteProject.js` with 404 → `ProjectNotFoundError` mapping
- [x] Wire `list` and `delete` CLI commands, export both from `src/index.js`
- [x] Add `ProjectNotFoundError` to `src/errors.js`
- [x] Run `cloudflare-pages-deploy list --json` against the real account — confirm the Phase 2 test project appears
- [x] Run `cloudflare-pages-deploy delete --slug <test-slug> --json` — confirm success result
- [x] Re-run `list --json` — confirm the project is gone
- [x] Run `delete` again on the same (now-gone) slug — confirm a clean `ProjectNotFoundError`, not a crash
- [x] Update README and `.ai/index.md`

**Tests:**

| Action | File | What it covers |
|---|---|---|
| create | `src/lib/listProjects.test.js` | mocked `cloudflareApi`: maps raw Cloudflare project objects to the package's `{name, subdomain, domains, productionBranch}` shape; empty-account case returns `[]` |
| create | `src/lib/deleteProject.test.js` | mocked `cloudflareApi`: success path resolves; 404 → `ProjectNotFoundError` (not a raw error) |

**Verification:**

- [x] Automated tests pass: `pnpm test`
- [x] Real `list --json` shows the Phase 2 test project
- [x] Real `delete --slug <test-slug> --json` succeeds, and a follow-up `list --json` no longer includes it
- [x] Real `delete` on an already-deleted slug returns a clean `ProjectNotFoundError` result, not a stack trace

**Phase review:**

- [x] All Steps and Verification checkboxes above ticked in the plan file
- [x] ~~Reviewer handoff prompt emitted in a fenced code block~~ (n/a — superseded by `/execute-prd` subagent dispatch)
- [x] ~~Orchestrator cleared context (`/clear`) and pasted the handoff prompt~~ (n/a — same reason)
- [x] Code-reviewer agent has verified this phase
- [x] Any changes made in response to code-reviewer suggestions reflected back into this plan file
- [x] Tests for this phase written and passing
- [x] Documentation updated (see Documentation section)
- [x] Orchestrator (user) has verified and approved this phase
- [x] Changes committed: `feat: add listProjects and deleteProject operations`
- [x] Phase marked complete

---

### Phase 4: Final Verification

**This phase runs after all other phases are complete.**
**Mode:** hil <!-- always hil: orchestrator manually verifies end-to-end. /execute-prd will not dispatch a subagent for this phase. -->

**Overall success criteria:**

- A person (or an AI agent driving the CLI) can point this package at any
  already-built static directory and an explicit slug, and get back a real
  live Cloudflare Pages URL — with zero manual Cloudflare-dashboard steps
  beyond the one-time token setup from Phase 1.
- All four operations (`deploy`, `list`, `delete`, `check-auth`) work against
  the real Cloudflare account, both as CLI commands and as the exported
  `deploy`/`listProjects`/`deleteProject` API.
- `--json` output is a single, stable, machine-parseable object per command —
  suitable for an AI agent to parse without regexing human text.
- No project, credential, or state is left behind from testing (final
  cleanup via `delete`).

**Steps:**

- [x] Every preceding phase's Steps/Verification/Phase review checkboxes are ticked in the plan file
- [x] ~~Reviewer handoff prompt emitted in a fenced code block~~ (n/a — superseded by `/execute-prd` subagent dispatch)
- [x] ~~Orchestrator cleared context (`/clear`) and pasted the handoff prompt~~ (n/a — same reason)
- [x] Code-reviewer agent reviews the entire change end-to-end
- [x] Any changes made in response to the final code-reviewer review reflected back into this plan file
- [x] All tests pass: `pnpm test`
- [x] No CLAUDE.md invariants violated (thin entry points, ~30-line functions, modular boundaries, no speculative abstractions, `.ai/` synced)
- [x] Feature tested manually end-to-end: fresh `check-auth` → `deploy` a real directory → `curl` the returned URL → `list` shows it → `delete` it → `list` no longer shows it
- [x] ~~Confirm `SlugTakenError` behaves as designed against a live colliding name~~ — **skipped by orchestrator decision (2026-08-19): verified by unit test only** (`ensureProject.test.js` covers Cloudflare error `8000003` → `SlugTakenError`). Not exercised against the live API.
- [x] Confirm no `.env` or token value was committed (`git log -p -- .env` empty, `git grep` for the raw token value returns nothing)
- [x] Overall success criteria met
- [x] All phase checkboxes above are ticked

## Documentation

| Change | Documentation location |
|---|---|
| Package purpose, install, setup | `README.md` |
| `check-auth` CLI + credential resolution | `README.md` (Phase 1 section) |
| `deploy()` API + CLI, error codes | `README.md` (Phase 2 section) |
| `list`/`delete` CLI + API | `README.md` (Phase 3 section) |
| Module map | `.ai/index.md` |
| Architecture (package shape, dependency direction, deploy data flow) | `.ai/architecture.md` |
| Wrangler-scope decision | `.ai/decisions/wrangler-scope-limited-to-upload.md` |
| Ensure-then-deploy decision | `.ai/decisions/no-auto-create-on-deploy.md` |
| Hostname-read-back decision | `.ai/decisions/hostname-read-back-not-constructed.md` |

## Knowledge Base Impact

| `.ai/` artifact | Action | What it captures |
|---|---|---|
| `index.md` | update | module rows for `auth/resolveAuth`, `lib/cloudflareApi`, `lib/deploy` (+ `validate`, `ensureProject`, `runWrangler`), `lib/listProjects`, `lib/deleteProject`, `cli` |
| `architecture.md` | update | system shape (single package, no sub-packages needed at this scope); dependency direction (`cli` → `lib` → `cloudflareApi`/`runWrangler`, never reverse); data flow (validate → ensure-project → upload via wrangler → read-back canonical URL) |
| `decisions/wrangler-scope-limited-to-upload.md` | create | why wrangler is scoped to only the upload step, REST for everything else — rejected alternative: using wrangler subcommands for create/list/delete too |
| `decisions/no-auto-create-on-deploy.md` | create | the core problem (non-interactive wrangler won't create Pages projects) and the ensure-then-deploy two-step solution — rejected alternative: reimplementing direct-upload against the raw REST API |
| `decisions/hostname-read-back-not-constructed.md` | create | why the final URL is always read back from Cloudflare's API instead of assumed as `<slug>.pages.dev` — the unresolved collision/suffix open question that motivates it |

## Tests

| Phase | Logic under test | Test file |
|---|---|---|
| Phase 1 | credential resolution precedence + missing-var error | `src/auth/resolveAuth.test.js` |
| Phase 1 | Cloudflare REST envelope handling | `src/lib/cloudflareApi.test.js` |
| Phase 1 | missing vs. invalid credential distinction | `src/cli/commands/checkAuth.test.js` |
| Phase 2 | slug/dir validation | `src/lib/validate.test.js` |
| Phase 2 | idempotent project creation | `src/lib/ensureProject.test.js` |
| Phase 2 | wrangler spawn wrapper (cwd/env control, exit code + 429 mapping) | `src/lib/runWrangler.test.js` |
| Phase 2 | deploy orchestration, hooks, single-credential-resolution | `src/lib/deploy.test.js` |
| Phase 3 | project listing/mapping | `src/lib/listProjects.test.js` |
| Phase 3 | project deletion + not-found mapping | `src/lib/deleteProject.test.js` |

## Human Summary

We're building a small, standalone Node package whose only job is publishing
an already-built directory to Cloudflare Pages and handing back the real live
URL. It exists because `wrangler pages deploy` refuses to auto-create a
missing project when run non-interactively (as any automation would run it) —
so this package always checks/creates the project first, then uploads.

Four phases: Phase 1 gets the plumbing right — package scaffold and
credential handling — and proves it against your real Cloudflare account via
a token-verification call (this is the phase where you create the API token
in the dashboard). Phase 2 is the actual feature: point it at a directory and
a slug, and get a real `https://<slug>.pages.dev` back, verified by literally
curling the URL. Phase 3 rounds out v1 with listing and deleting projects, so
throwaway demo sites don't quietly eat into the 100-project account cap.
Phase 4 is an end-to-end human check across everything, including confirming
that a colliding slug fails cleanly (Cloudflare rejects taken names outright
rather than silently suffixing them — verified during planning) and that
undocumented direct-upload rate limits are handled defensively.

Key trade-offs: wrangler is used for exactly one thing — the actual file
upload — because that's the only operation Cloudflare doesn't expose a plain
documented REST endpoint for; everything else (verify, list, create, delete,
and reading back the canonical URL) goes through `fetch` directly, which is
both simpler and easier to test. State is never persisted locally — every
result the package produces is read straight back from Cloudflare, including
the final URL, so it can never drift from what's actually live. Phase 0
deviates from this project's usual plan format by skipping the git-worktree
step (no concurrent work to isolate from, on a single-developer greenfield
package) while still initializing git, since the phase-per-commit workflow
genuinely needs it. A couple of things were deliberately left out of scope
for v1 after a second look: automatic retry-with-backoff on rate limiting
(429s are undocumented enough that any backoff number would be a guess — the
package reports the failure clearly instead) and a configurable deploy
branch (the locked decisions already fix it at `main`).
