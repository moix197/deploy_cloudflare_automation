# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module / package | Responsibility (one line) | Path | Decisions / patterns |
| ---------------- | ------------------------- | ---- | -------------------- |
| `auth/resolveAuth` | Resolves `{apiToken, accountId}` by precedence (args → the **package's own** `.env`, resolved from `import.meta.url`, never the caller's cwd → `process.env`); throws `MissingCredentialError` naming the exact missing var | `src/auth/resolveAuth.js` | [env-resolved-from-package-root](decisions/env-resolved-from-package-root.md), [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `errors` | Single home for every typed error the package throws (`CliError` base + all subclasses, including the Cloudflare-REST-specific ones); `lib/cloudflareApi` re-exports its three for import-path back-compat | `src/errors.js` | |
| `lib/cloudflareApi` | Thin Cloudflare REST client (`cloudflareFetch`, `verifyToken`); unwraps the `{success, errors, result}` envelope, throwing the typed errors defined in `errors.js` | `src/lib/cloudflareApi.js` | [wrangler-scope-limited-to-upload](decisions/wrangler-scope-limited-to-upload.md) |
| `cli` | Arg parsing + command dispatch (`bin/cloudflare-pages-deploy.js` → `src/cli/cli.js` → `src/cli/commands/*`); `cli.js` owns the human/`--json` printing of whatever a handler returns — except `commands/list.js`, which prints its own table and returns `{}` on the human path; handlers call their one `lib` operation and let it self-resolve credentials, the exception being `check-auth`, which has no backing `lib` operation and so calls `resolveAuth()` and `cloudflareApi.verifyToken` itself | `src/cli/` | [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `lib/validate` | `validateSlug`/`validateDir` — local, pre-network validation of CLI/API input | `src/lib/validate.js` | |
| `lib/ensureProject` | Idempotent get-or-create of a Pages project by slug; distinguishes a recoverable concurrent-create race from a genuinely taken slug | `src/lib/ensureProject.js` | [no-auto-create-on-deploy](decisions/no-auto-create-on-deploy.md), [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `lib/runWrangler` | Spawns the local `wrangler` binary for the upload step only; fixed `cwd`, no TTY, no shell, maps exit codes to typed errors | `src/lib/runWrangler.js` | [wrangler-scope-limited-to-upload](decisions/wrangler-scope-limited-to-upload.md), [spawn-wrangler-js-entrypoint-no-shell](decisions/spawn-wrangler-js-entrypoint-no-shell.md), [no-retry-on-rate-limit](decisions/no-retry-on-rate-limit.md), [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `lib/deploy` | Orchestrates validate → ensure-project → upload → URL readback; single `resolveAuth()` call shared by both REST and wrangler paths | `src/lib/deploy.js` | [no-auto-create-on-deploy](decisions/no-auto-create-on-deploy.md), [hostname-read-back-not-constructed](decisions/hostname-read-back-not-constructed.md), [no-retry-on-rate-limit](decisions/no-retry-on-rate-limit.md), [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `lib/listProjects` | Lists Pages projects for the account, mapped to `{name, subdomain, domains, productionBranch}`; self-resolves `{apiToken, accountId}` via `resolveAuth` when the caller doesn't supply them (explicit args still win) | `src/lib/listProjects.js` | [pages-projects-per-page-must-be-10](decisions/pages-projects-per-page-must-be-10.md), [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `lib/deleteProject` | Deletes a Pages project by slug; maps a 404 to typed `ProjectNotFoundError`; self-resolves credentials the same way `listProjects` does | `src/lib/deleteProject.js` | [env-resolved-from-package-root](decisions/env-resolved-from-package-root.md), [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |
| `index` (public API) | Barrel export of the library surface (`deploy`, `listProjects`, `deleteProject`) plus every error class from `errors.js`; resolvable via the package's `exports` map (`import ... from 'cloudflare-pages-deploy'`) | `src/index.js` | |

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| Cloudflare-imposed limits | `src/lib/ensureProject.js` (create), `src/lib/deleteProject.js` (reaping) | `.pages.dev` names are globally unique (community-reported, undocumented), so slug collision with an unrelated account is the likeliest real failure; a taken name fails outright with error `8000003` and is **never** auto-suffixed (that's dashboard-only); 100 projects per account, so demo projects must be reaped via `delete`. See [architecture.md § Operating constraints](architecture.md#operating-constraints) |
| Credential exposure | `src/auth/resolveAuth.js` | `.env` is read from the package root, so any process that can run this code inherits account-wide Pages Edit, `delete` included — accepted, with reopen triggers, in [env-resolved-from-package-root](decisions/env-resolved-from-package-root.md) |
| Test seams | every module with a side effect | Collaborators injected as default parameters (`resolveAuthFn`, `cloudflareFetchFn`, `spawnFn`, …), no DI framework, no module mocking — [injectable-collaborators-via-default-params](patterns/injectable-collaborators-via-default-params.md) |

> Update via the `sync-knowledge` skill — don't hand-edit drift in.
