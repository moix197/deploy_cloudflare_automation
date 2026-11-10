# Injectable collaborators via default parameters

Every module whose real work is a side effect (network, child process, disk)
takes its collaborator as a **destructured parameter with the real
implementation as the default**. Tests pass a substitute; production code
never passes anything.

## The convention

```js
export async function listProjects({ apiToken, accountId, cloudflareFetchFn = cloudflareFetch, resolveAuthFn = resolveAuth } = {}) {
```

Naming: the collaborator's own name plus `Fn` (`resolveAuthFn`,
`cloudflareFetchFn`, `spawnFn`, `ensureProjectFn`, `runWranglerFn`,
`readProjectSubdomainFn`). Non-function seams keep their plain name
(`env`, `envFile`, `binPath`). Every injected parameter's JSDoc says
"injectable for tests; real callers never pass them" — that line is what
stops a future reader mistaking a test seam for public API.

Where it is used today:

| Module | Seams |
| ------ | ----- |
| `src/auth/resolveAuth.js` | `env`, `envFile` (second options arg, so overrides stay the first) |
| `src/lib/runWrangler.js` | `spawnFn`, `binPath` |
| `src/lib/ensureProject.js` | `cloudflareFetchFn` |
| `src/lib/listProjects.js` | `cloudflareFetchFn`, `resolveAuthFn` |
| `src/lib/deleteProject.js` | `cloudflareFetchFn`, `resolveAuthFn` |
| `src/lib/deploy.js` | `resolveAuthFn`, `ensureProjectFn`, `runWranglerFn`, `readProjectSubdomainFn` |
| `src/cli/commands/checkAuth.js` | `resolveAuthFn`, `verifyTokenFn` |
| `src/lib/sharded/shardedDeploy.js` | `db` (D1 executor), `cloudflareFetchFn`, `resolveAuthFn`, `lockOptions`, `ensureProjectFn` |
| `src/lib/sharded/shardLock.js` | `now`, `sleep`, `holder` |
| `worker/src/index.js` | `fetchFn`, `cache` |

## Why not a DI container or module mocking

No framework and no loader hooks: `node --test` with zero test dependencies
is the whole test setup, and Node's ESM module registry has no first-class
in-process mock. Default parameters give the same substitutability in plain
JavaScript, stay visible in the function signature, and cost nothing at
runtime.

## When NOT to add a seam

Only add one a test actually uses. `deploy.js` originally carried a
`cloudflareFetchFn` that nothing injected — its network call sits inside
`readProjectSubdomain`, which is already replaceable via
`readProjectSubdomainFn` — so it was removed as a speculative seam. One seam
per collaborator, at the level the tests substitute; a seam that no test
exercises is dead parameter surface.
