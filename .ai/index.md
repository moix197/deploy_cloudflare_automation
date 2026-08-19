# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module / package | Responsibility (one line) | Path | Decisions / patterns |
| ---------------- | ------------------------- | ---- | -------------------- |
| `auth/resolveAuth` | Resolves `{apiToken, accountId}` by precedence (args → `.env` → `process.env`); throws `MissingCredentialError` naming the exact missing var | `src/auth/resolveAuth.js` | |
| `errors` | Single home for every typed error the package throws (`CliError` base + all subclasses, including the Cloudflare-REST-specific ones); `lib/cloudflareApi` re-exports its three for import-path back-compat | `src/errors.js` | |
| `lib/cloudflareApi` | Thin Cloudflare REST client (`cloudflareFetch`, `verifyToken`); unwraps the `{success, errors, result}` envelope, throwing the typed errors defined in `errors.js` | `src/lib/cloudflareApi.js` | [wrangler-scope-limited-to-upload](decisions/wrangler-scope-limited-to-upload.md) |
| `cli` | Arg parsing + command dispatch (`bin/cloudflare-pages-deploy.js` → `src/cli/cli.js` → `src/cli/commands/*`); shared human/`--json` output formatting; command handlers never call `resolveAuth()` themselves — they call the `lib` operation, which self-resolves | `src/cli/` | |
| `lib/validate` | `validateSlug`/`validateDir` — local, pre-network validation of CLI/API input | `src/lib/validate.js` | |
| `lib/ensureProject` | Idempotent get-or-create of a Pages project by slug; distinguishes a recoverable concurrent-create race from a genuinely taken slug | `src/lib/ensureProject.js` | [no-auto-create-on-deploy](decisions/no-auto-create-on-deploy.md) |
| `lib/runWrangler` | Spawns the local `wrangler` binary for the upload step only; fixed `cwd`, no TTY, maps exit codes to typed errors | `src/lib/runWrangler.js` | [wrangler-scope-limited-to-upload](decisions/wrangler-scope-limited-to-upload.md) |
| `lib/deploy` | Orchestrates validate → ensure-project → upload → URL readback; single `resolveAuth()` call shared by both REST and wrangler paths | `src/lib/deploy.js` | [no-auto-create-on-deploy](decisions/no-auto-create-on-deploy.md), [hostname-read-back-not-constructed](decisions/hostname-read-back-not-constructed.md) |
| `lib/listProjects` | Lists Pages projects for the account, mapped to `{name, subdomain, domains, productionBranch}`; self-resolves `{apiToken, accountId}` via `resolveAuth` when the caller doesn't supply them (explicit args still win) | `src/lib/listProjects.js` | [pages-projects-per-page-must-be-10](decisions/pages-projects-per-page-must-be-10.md) |
| `lib/deleteProject` | Deletes a Pages project by slug; maps a 404 to typed `ProjectNotFoundError`; self-resolves credentials the same way `listProjects` does | `src/lib/deleteProject.js` | |
| `index` (public API) | Barrel export of the library surface (`deploy`, `listProjects`, `deleteProject`) plus every error class from `errors.js`; resolvable via the package's `exports` map (`import ... from 'cloudflare-pages-deploy'`) | `src/index.js` | |

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| _empty_ | | |

> Update via the `sync-knowledge` skill — don't hand-edit drift in.
