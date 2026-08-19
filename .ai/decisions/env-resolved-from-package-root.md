# `.env` is read from the package root, so any caller inherits account-wide credentials

## Context

`resolveAuth` (`src/auth/resolveAuth.js`) derives `PACKAGE_ROOT` from
`import.meta.url` and reads `<PACKAGE_ROOT>/.env` — **not** the caller's
`process.cwd()`. Combined with the token this package documents
(`.env.example`: "Cloudflare Pages: Edit", account-scoped), the effect is:

> Any process that can execute this package's code — CLI or library import —
> gets account-wide Cloudflare Pages Edit without supplying a credential,
> including the destructive `deleteProject` path.

There is no per-command confirmation, no allowlist of slugs, and no
separation between the read, deploy and delete surfaces.

## Decision

Accept it, deliberately, for the current usage envelope:

- The account holds throwaway client demo sites, not production properties.
- The package is `private: true`, not published and not on `PATH`; it is run
  supervised by Claude Code under a human, not by autonomous agents.
- Package-root `.env` is what makes the package callable from any working
  directory (its whole point: deploy *some other* directory's build output),
  so cwd-relative `.env` would break the primary use case.

## Rejected alternatives

All reviewed and declined as costing more than the risk they remove *at this
usage envelope*:

- **Drop `delete` from the agent-facing surface.** Rejected: reaping demo
  projects is the reason `deleteProject` shipped in v1 at all (100-project
  account cap).
- **Per-project token scoping instead of account-wide Pages Edit.** The
  token's finest Pages grain in Cloudflare's own create-token flow is
  `Account` → `Cloudflare Pages` → `Edit`, scoped by *account resource* (see
  README's Manual Setup) — there is no per-project resource to narrow to.
- **Require explicit `{apiToken, accountId}` for destructive operations.**
  Rejected: it only relocates the credential, since whatever calls the
  package can read the same `.env`.
- **Move `.env` outside the package.** Rejected: same exposure (the path
  would still be hardcoded and readable), plus it breaks the
  copy-`.env.example` setup flow.

## Reopen this decision when

Any one of these changes:

- invocation becomes autonomous (agent loops without a human approving each
  run),
- the package is put on `PATH`, published, or installed as a dependency of
  something else,
- the account starts holding anything beyond throwaway demo sites.

At that point the declined options above become the shortlist, starting with
removing `delete` from the agent-facing surface.
