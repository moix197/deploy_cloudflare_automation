# Spawn wrangler's JS entrypoint via `process.execPath`, never the `.bin` shim

## Context

The obvious way to run wrangler from Node is to spawn the `.bin/wrangler`
shim that the package manager installs. On Windows that shim is a `.cmd`
file, which `child_process.spawn` cannot execute without `shell: true`.

`shell: true` is the trap: Node does **not** quote argv when a shell is
involved — it hands the joined string to the shell. So the site directory
`C:\Users\Some User\site` arrives as two arguments and wrangler uploads the
wrong path (or nothing), and a directory name containing shell metacharacters
becomes a command-injection vector. The site directory is caller-supplied,
so neither is hypothetical.

## Decision

`src/lib/runWrangler.js` spawns `process.execPath` (the running Node binary)
with the resolved `bin/wrangler.js` as the first argument and no `shell`
option at all. Since a `.js` file needs no shim to be executable by Node,
argv reaches wrangler exactly as built, on every platform.

Two related constraints in the same call:

- **`cwd` is fixed to this package's own directory.** Wrangler walks *up*
  from its cwd looking for `wrangler.toml`/`wrangler.jsonc`; a stray config
  in any ancestor of the caller's site directory would silently hijack the
  run. This package ships no wrangler config, so its own root is a
  guaranteed-clean discovery base.
- **The site directory is passed as an absolute path** (`deploy()` resolves
  it via `resolvePath`). Because `cwd` is the package root and not the
  caller's, a relative path would resolve against the wrong base — absolute
  is what decouples asset-directory resolution from config discovery.

The entrypoint itself is located with `createRequire(...).resolve('wrangler/package.json')`
rather than a hardcoded `<pkg>/node_modules/wrangler/...`, which would break
under hoisted or consumer-monorepo layouts; `package.json` is the resolve
target because wrangler's `exports` map blocks resolving the bin subpath.

## Rejected alternatives

- **`.bin` shim with `shell: true`** — the quoting and injection problems
  above.
- **`npx wrangler`** — adds a resolution step that can reach the network and
  pick a different version than the pinned dependency.

## Consequence

`runWrangler` depends on wrangler's on-disk layout (`bin/wrangler.js`), which
is not part of wrangler's public `exports`. A wrangler release that moves or
renames that file breaks the spawn — which is why a missing entrypoint is its
own typed `MissingWranglerEntrypointError`, checked before spawning, instead
of surfacing as an opaque exit code.
