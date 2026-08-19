# Knowledge Index

The map agents read first. One row per module/package: its single responsibility,
where it lives, and links to any decision or pattern doc. Keep rows terse —
this is a lookup table, not documentation. Retire rows that no longer point
anywhere real.

## Modules

| Module / package | Responsibility (one line) | Path | Decisions / patterns |
| ---------------- | ------------------------- | ---- | -------------------- |
| `auth/resolveAuth` | Resolves `{apiToken, accountId}` by precedence (args → `.env` → `process.env`); throws `MissingCredentialError` naming the exact missing var | `src/auth/resolveAuth.js` | |
| `lib/cloudflareApi` | Thin Cloudflare REST client (`cloudflareFetch`, `verifyToken`); unwraps the `{success, errors, result}` envelope into typed errors | `src/lib/cloudflareApi.js` | [wrangler-scope-limited-to-upload](decisions/wrangler-scope-limited-to-upload.md) |
| `cli` | Arg parsing + command dispatch (`bin/cloudflare-pages-deploy.js` → `src/cli/cli.js` → `src/cli/commands/*`); shared human/`--json` output formatting | `src/cli/` | |

## Cross-cutting

| Concern | Where it's handled | Notes |
| ------- | ------------------ | ----- |
| _empty_ | | |

> Update via the `sync-knowledge` skill — don't hand-edit drift in.
