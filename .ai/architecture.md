# Architecture

The high-level shape of the system: package boundaries, how data flows, and the
rules that keep dependencies pointing one direction. Capture the *structure and
its rationale* — not API-level detail the code already documents.

## System shape

Single package (`cloudflare-pages-deploy`), no sub-packages. At this scope —
one CLI plus a handful of library functions, all talking to one external
system (Cloudflare) — splitting into multiple `@scope/*` packages would add
publishing/dependency-graph ceremony with no real isolation benefit; there is
only one consumer-facing boundary (the library surface in `src/index.js`) and
one implementation behind it.

Internal layout, by responsibility:
- `bin/` — executable shim only, no logic.
- `src/cli/` — argument parsing and command dispatch. Thin by design: each
  command file parses its own flags, calls exactly one `src/lib/*` operation,
  and returns a plain object that `cli.js` prints — as `key: value` lines, or
  as `{ok: true, ...result}` JSON under `--json`. `src/cli/commands/list.js`
  is the exception: an array of projects renders as `[object Object]` through
  that generic printer, so on the human path it prints its own table and
  returns `{}`, leaving `printResult` nothing to add (the `--json` path still
  returns `{projects, count}` and prints through `cli.js` unchanged). No
  business logic lives here. Credential resolution and direct Cloudflare API
  calls are also out of scope here,
  except for `checkAuthCommand` (`src/cli/commands/checkAuth.js`), which has
  no corresponding `src/lib/` operation to delegate to and so calls
  `resolveAuth()` and `src/lib/cloudflareApi.js` directly — see the
  Dependency direction section below.
- `src/lib/` — the actual operations (`deploy`, `listProjects`,
  `deleteProject`) plus their shared building blocks (`validate`,
  `ensureProject`, `runWrangler`, `cloudflareApi`). This is also the public
  library surface, barrelled through `src/index.js`.
- `src/auth/` — credential resolution (`resolveAuth`), consumed by `src/lib/*`
  directly. The one exception is `src/cli/commands/checkAuth.js`, which calls
  `resolveAuth()` itself — see the Dependency direction section below. The
  `.env` it reads is the *package's own*, resolved from `import.meta.url` and
  never from the caller's cwd — see
  [env-resolved-from-package-root](decisions/env-resolved-from-package-root.md)
  for the security trade-off that implies.
- `src/errors.js` — single home for every typed error the package throws,
  including the Cloudflare-REST-specific ones (`CloudflareHttpError`,
  `CloudflareApiError`, `CloudflareResponseParseError`); `cloudflareApi.js`
  re-exports those three so existing `from './cloudflareApi.js'` imports keep
  working without churn.

## Dependency direction

`cli` → `lib` → `cloudflareApi` / `runWrangler`, never reverse:

- `src/cli/cli.js` → `src/cli/commands/*` → `src/lib/{deploy,listProjects,deleteProject}.js`.
- `src/lib/{deploy,ensureProject,listProjects,deleteProject}.js` →
  `src/lib/cloudflareApi.js` (REST, everything except the upload) and, for
  `deploy` only, `src/lib/runWrangler.js` (the one operation with no REST
  equivalent — see
  [wrangler-scope-limited-to-upload](decisions/wrangler-scope-limited-to-upload.md)).
- `src/lib/{deploy,listProjects,deleteProject}.js` → `src/auth/resolveAuth.js`
  directly, so there is exactly one place per operation that touches
  credentials. `listProjects`/`deleteProject` accept optional
  `{apiToken, accountId}` params and forward them into `resolveAuth`, where
  explicit args still win over `.env`/`process.env` (`resolveAuth`'s own
  precedence). `deploy` is asymmetric with the other two here: it takes no
  `apiToken`/`accountId` params at all and calls `resolveAuthFn()` with no
  arguments, so it always resolves from `.env`/`process.env` — a caller
  cannot inject explicit credentials into `deploy()` the way it can into
  `listProjects()`/`deleteProject()`. `src/cli/commands/{deploy,list,delete}.js` do
  **not** call `resolveAuth()` themselves; they call the `lib` operation and
  let it resolve, which is what keeps those CLI entry points thin per
  CLAUDE.md. `src/cli/commands/checkAuth.js` is the one exception: `check-auth`
  is a credential-diagnostic command with no `src/lib/` operation behind it,
  so it necessarily calls `resolveAuth()` and `src/lib/cloudflareApi.js`
  (`verifyToken`) directly rather than going through a `lib` operation.
- Nothing in `src/lib/` or `src/auth/` imports from `src/cli/`, and
  `cloudflareApi.js`/`runWrangler.js` never import from the operations that
  call them — dependencies only point downward.

## Data flow

**`deploy(dir, slug)`:** `resolveAuth()` once → `validateSlug` +
`validateDir` (local, pre-network) → `onStart` hook → `ensureProject` (REST
GET by slug; POST-create only if missing; a concurrent same-account create is
treated as success, a genuinely taken slug throws `SlugTakenError`) →
`onProgress('uploading')` hook → `runWrangler` spawns `wrangler pages deploy`
for the upload — the only step that touches wrangler — → REST GET readback of
the project's `subdomain` (the live URL is always read back from Cloudflare,
never constructed as `<slug>.pages.dev` — see
[hostname-read-back-not-constructed](decisions/hostname-read-back-not-constructed.md))
→ `onDone` hook → returns `{url, slug, projectName, status}`. Any error along
the way fires `onError` before rethrowing.

**`listProjects()` / `deleteProject(slug)`:** self-resolve credentials via
`resolveAuth`, but — unlike `deploy` — accept optional `{apiToken, accountId}`
overrides that take precedence when supplied → (delete only) `validateSlug`
before any network call
→ REST call through `cloudflareApi.cloudflareFetch` → typed-error mapping
(e.g. delete's 404 → `ProjectNotFoundError`, not a raw HTTP error) → stable
output shape (`{name, subdomain, domains, productionBranch}[]` /
`{slug, status}`).

No local state is ever persisted — every result, including the final URL, is
read straight back from Cloudflare on each call.

## Operating constraints

External limits that shape the design, not incidental trivia:

- **`.pages.dev` names are a global namespace.** Cloudflare documents nothing
  about the scope of project-name uniqueness; community reports
  (workers-sdk#3527) say it is global, not per-account. So the likeliest
  real-world failure of `deploy()` is not a bug here — it is a slug colliding
  with a project in a completely unrelated account.
- **A taken name fails outright, and is never auto-suffixed.** Creation
  returns Cloudflare error `8000003`; the "we picked `my-app-abc` for you"
  behaviour is dashboard-UX-only and does not exist at the API level. That is
  what makes `SlugTakenError` a terminal "choose another slug", and what lets
  the URL readback be a confirmation rather than a collision recovery.
- **100 Pages projects per account, on every plan**, and Cloudflare states
  the cap is "not routinely increased." Since this package exists to publish
  throwaway demo sites, they accumulate against that cap — which is why
  `deleteProject` shipped in v1 rather than being deferred: reaping is part
  of normal operation, not a maintenance extra.

## Known gaps

Deliberately-accepted holes, recorded so they are not rediscovered as bugs:

- **`SlugTakenError` has never been exercised against the live API.** It is
  covered by unit test only (`ensureProject.test.js`, Cloudflare error
  `8000003` → `SlugTakenError`); verifying it for real would mean colliding
  with a stranger's live project name. Accepted at plan closeout.
- **`deploy()` cannot take explicit credentials, `listProjects()`/
  `deleteProject()` can.** The asymmetry described under Dependency direction
  is a decision, not an oversight: nothing needs per-call credentials on the
  deploy path, and adding the parameters purely for symmetry would widen the
  surface through which a token can be passed around. Left as-is until a real
  caller needs it.

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
