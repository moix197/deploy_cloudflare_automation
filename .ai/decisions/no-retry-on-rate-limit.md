# `RateLimitError` propagates to the caller; no retry, no backoff

## Context

`src/lib/runWrangler.js` classifies a non-zero wrangler exit whose stderr
looks 429-shaped (`\b429\b` or `/rate.?limit/i`) as `RateLimitError` rather
than a generic `WranglerExecutionError`. An earlier draft had `deploy()`
auto-retry once with backoff on that error.

Cloudflare documents **no** rate limits for the Pages direct-upload path — no
window, no threshold, no `Retry-After` guarantee. Any backoff constant would
therefore be a guessed number wearing the costume of a mechanism, and a retry
would double the upload work on the exact failure where the account is
already over budget.

## Decision

Cut the retry. `RateLimitError` propagates straight out of `deploy()` — the
`onError` hook fires, the CLI prints it, and the caller decides. The typed
error is kept (it is the only thing that lets a caller distinguish "back off
and try later" from "this deploy is broken"); only the automatic recovery is
gone.

## Rejected alternative

Retry-once-with-backoff inside `deploy()`. Rejected as over-engineering: a
real retry policy needs visibility into actual 429 frequency, which lives in
the consuming application, not in a single-shot deploy function. This
package's job is to report the failure precisely enough to be acted on.

## Consequence

Callers that deploy in a loop must implement their own pacing. If direct
upload limits ever get documented — or observed frequently enough to derive a
window — this is the decision to revisit, and the classification in
`runWrangler` is already the hook a policy would attach to.
