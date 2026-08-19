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
  and shapes the result for printing. No business logic lives here. Credential
  resolution and direct Cloudflare API calls are also out of scope here,
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
  `resolveAuth()` itself — see the Dependency direction section below.
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

> Update via the `sync-knowledge` skill when an architectural boundary, package,
> or flow is introduced or changed.
