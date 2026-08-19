# Research: Cloudflare Pages programmatic deployment (wrangler + REST API)

Date: 2026-08-18. Sources are Cloudflare official docs unless marked otherwise.

---

## Part A — Local state of `C:\proyectos\web-express\deploy_cloudflare_automation`

Repo root contents:

```
.ai/            architecture.md, index.md, README.md, decisions/ (empty), patterns/ (empty)
.claude/skills/ execute-prd, grill-me, plan, plan-issues, plan-sequential, sync-knowledge, write-prd (SKILL.md each)
plans/          EMPTY (no prior plan)
CLAUDE.md       project instructions
```

Findings:

- **No `package.json`.** No `node_modules`, no lockfile, no `src/`. Greenfield.
- **No `.git`** directory — not a git repo yet.
- **`.ai/` is an untouched scaffold.** `index.md` module table has one `_empty_` row and literally says
  "Empty scaffold. Add the first row when the first module lands." `architecture.md` sections are all
  `_Empty. ..._` placeholders. `decisions/` and `patterns/` are empty dirs. So there is **no prior
  project knowledge** to reuse — everything must be authored.
- **`.claude/`** holds only the planning-workflow skills (write-prd / execute-prd / plan-sequential /
  plan-issues / sync-knowledge / grill-me). No custom agents, no `settings.json`, no MCP config,
  nothing Cloudflare-specific.
- **`plans/` is empty** — no existing PRD. This research dir is the first thing in it.

Implication: the plan starts from zero — package scaffolding, pnpm init, tsconfig, and the deploy
package all need to be created. Note CLAUDE.md mandates **pnpm** and a **modular-by-package** layout.

---

## Part B — External research

### 1. Does `wrangler pages deploy` auto-create the project?

**Command:** `npx wrangler pages deploy [DIRECTORY] --project-name=<NAME>`
Doc: https://developers.cloudflare.com/workers/wrangler/commands/pages/

- **Interactive TTY:** yes — the Direct Upload guide states you can "streamline the project creation
  and asset deployment steps by using the `wrangler pages deploy` command to both create and deploy
  assets at the same time… you will still be prompted to specify your project name and production
  branch", which are then cached in `node_modules/.cache/wrangler`.
  Doc: https://developers.cloudflare.com/pages/get-started/direct-upload/
- **Non-interactive (CI / spawned process / no TTY): NO — it fails.** The creation path is a prompt,
  and wrangler's design is: when not running interactively it errors instead of prompting. Observed
  failures: `[ERROR] This command cannot be run in a non-interactive context` and API error
  `code: 8000007, "Project not found. The specified project name does not match any of your existing
  projects"`.
  Non-doc corroboration (upstream repo/community):
  - https://github.com/cloudflare/workers-sdk/issues/2405 (feature request: deploy should create the
    project when `--project-name` is given and it doesn't exist)
  - https://github.com/cloudflare/wrangler2/issues/821 (interactive prompt on missing project)
  - https://community.cloudflare.com/t/can-i-use-wrangler-pages-deploy-command-to-create-a-project-if-it-doesnt-exist/662891
- **Therefore the reliable automation sequence is two commands:**
  1. `npx wrangler pages project create <PROJECT_NAME> --production-branch=main`
     (idempotency caveat: re-running for an existing name returns an unhelpful error —
     https://github.com/cloudflare/workers-sdk/issues/3527 — so either check existence first via
     `wrangler pages project list --json` / REST `GET /accounts/{id}/pages/projects`, or tolerate and
     parse the "already exists" failure.)
  2. `npx wrangler pages deploy <DIR> --project-name=<NAME> --branch=main --commit-dirty=true`
- The CI guide's own canonical snippet is exactly this: create first, then
  `CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID> npx wrangler pages deploy <DIRECTORY> --project-name=<PROJECT_NAME>`.
  Doc: https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- `--commit-dirty=true` is needed when running inside a dirty git workspace, otherwise wrangler warns /
  prompts about uncommitted changes. Outside a git repo, `--branch` must be supplied manually because
  wrangler cannot infer it.
- The `--yes` flag exists for *automatic project configuration* in the Workers/framework
  auto-configuration flow ("skip confirmation prompts and run automatic project configuration
  non-interactively using detected settings, only applicable when no Wrangler configuration file
  exists"), doc: https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/ —
  it is **not** documented as a flag of `wrangler pages deploy`; do not rely on it there.

**Version / package name:** package is exactly **`wrangler`** on npm. Latest published version at time
of research: **4.124.0** (`registry.npmjs.org/wrangler` dist-tag `latest`). Current major is **v4**;
there is no v5 referenced anywhere in the docs.
Docs: https://developers.cloudflare.com/workers/wrangler/install-and-update/ ,
https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/
Install pinned: `pnpm add -D wrangler@4` (or `pnpm dlx wrangler@4 …`).

### 2. Auth env vars (exact names)

Doc: https://developers.cloudflare.com/workers/wrangler/system-environment-variables/

| Variable | Meaning | Needed? |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | "The API token for your Cloudflare account, can be used for authentication for situations like CI/CD" | **Yes** — this is the non-interactive auth path |
| `CLOUDFLARE_ACCOUNT_ID` | "The account ID for the Workers related account" | **Yes in practice** — required when the token can see >1 account; the CI doc passes it explicitly |
| `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | legacy global-key auth | No — avoid |
| `CLOUDFLARE_ENV` | selects env instead of `--env` | No |
| `WRANGLER_SEND_METRICS` | set `false` to disable telemetry (avoids a first-run prompt) | Recommended `false` |
| `WRANGLER_LOG` | `none\|error\|warn\|info\|log\|debug` | Useful for debugging |
| `WRANGLER_SEND_ERROR_REPORTS` | error-report opt-out | Optional |

There is **no documented `CI` variable** consumed by wrangler; non-interactivity is detected from
whether stdin/stdout is a TTY. When spawning wrangler from Node, do **not** allocate a TTY, and expect
prompts to become hard errors.

### 3. Minimum API token permissions

- Pages deploy/create: **Account → `Cloudflare Pages` → `Edit`**. Exact doc wording: "Under
  **Permissions**, select *Account*, *Cloudflare Pages* and *Edit*."
  Doc: https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- REST API page states: "At least one of the following token permissions is required: `Pages Read` or
  `Pages Write`" (Write = the Edit level; Read is insufficient to create/deploy).
  Doc: https://developers.cloudflare.com/pages/configuration/api/
- **`Account Settings: Read`** — not strictly required to *deploy* when `CLOUDFLARE_ACCOUNT_ID` is
  supplied. It is what lets a token **enumerate accounts** (`GET /accounts`), which wrangler does when
  no account id is set. Cloudflare's own generated Workers CI token template includes
  `Account: Account Settings (read)` alongside the edit scopes.
  Docs: https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ,
  https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- **Recommended token for this project:**
  - `Account` → `Cloudflare Pages` → `Edit` (mandatory)
  - `Account` → `Account Settings` → `Read` (optional; include if you want to auto-discover the
    account id instead of requiring the user to paste `CLOUDFLARE_ACCOUNT_ID`)
  - Scope to the one specific account, not "All accounts".
  - Token creation UI: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/

### 4. Raw REST API alternative to wrangler

- Create project: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects`
  Headers `Content-Type: application/json`, `Authorization: Bearer $CLOUDFLARE_API_TOKEN`.
  Body: `{"name": "my-pages-app", "production_branch": "main"}`.
  Doc: https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/
- List projects: `GET /accounts/{account_id}/pages/projects` (use for idempotent "does it exist?").
- Update production branch: `PATCH /accounts/{account_id}/pages/projects/{project_name}` with
  `production_branch`. Doc: https://developers.cloudflare.com/pages/get-started/direct-upload/
- Create deployment:
  `POST /accounts/{account_id}/pages/projects/{project_name}/deployments`
  **Content-Type: `multipart/form-data`**, form fields include `branch`, `commit_dirty`,
  `commit_hash`, `commit_message`, `manifest` (JSON map of file path → content hash),
  `pages_build_output_dir`.
  Doc: https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/
  **This endpoint does not take the file bytes.** It references files by hash via `manifest`; the bytes
  must already have been uploaded through the undocumented asset-upload path (obtain a short-lived
  upload JWT, `check-missing` to diff hashes against what Cloudflare already stores, then batch-upload
  the missing blobs base64-encoded, then create the deployment with the manifest). Cloudflare only
  documents the analogous flow for Workers static assets — an `assets-upload-session` returning a JWT
  valid one hour plus `buckets` batching hints, and a completion JWT after all files land:
  https://developers.cloudflare.com/workers/static-assets/direct-upload/ . The equivalent Pages
  endpoints (`/pages/assets/check-missing`, `/pages/assets/upload`, project `upload-token`) are **not
  in the public API reference** and are effectively wrangler-internal.

  **Verdict (one sentence): No — implementing raw-API direct upload without wrangler is not realistic,
  because the deployment endpoint only accepts a hash manifest and the actual file-upload/JWT flow for
  Pages is undocumented and unversioned; use wrangler as the upload engine and reserve the REST API for
  the documented project create/list/patch/delete operations.**

### 5. Limits

Doc: https://developers.cloudflare.com/pages/platform/limits/

| Limit | Value |
| --- | --- |
| Files per site/deployment (Free) | 20,000 |
| Files per site (paid) | 100,000 (requires env `PAGES_WRANGLER_MAJOR_VERSION=4`) |
| Max single asset file size | **25 MiB** (use R2 for larger) |
| Projects per account | **100** (not routinely increased) |
| New-account rate limit | project creation restricted during the first 48 h after account creation |
| Builds — Free | 1 concurrent, **500 builds/month** |
| Builds — Pro / Business | 5 / 20 concurrent; 5,000 / 20,000 per month |
| Build timeout | 20 minutes |
| Preview deployments | unlimited |
| Custom domains per project | 100 Free / 250 Pro / 500 Business / 500 Enterprise |
| `_headers` | 100 rules, 2,000 chars per header |
| `_redirects` | 2,000 static + 100 dynamic = 2,100 total |

Notes:
- The documented monthly quota (500) applies to **CI builds**; Direct Upload deployments do not run a
  Cloudflare build, so they are not billed against the build quota — but there is no published
  "deployments per day" number for direct upload. Treat it as unpublished/soft-limited and add
  client-side backoff on 429.
- Zip archives are not accepted — you must point at a folder.

**Project name rules** (not on the limits page; from the Pages docs + API behavior):
- Alphanumeric characters and dashes only; lowercase. Doc language: "The name of your Pages project
  must use alphanumeric and dashes only." Branch/name aliases are "lowercased and non-alphanumeric
  characters are replaced with a hyphen"
  (https://developers.cloudflare.com/pages/configuration/preview-deployments/).
- The name becomes the subdomain: the project is served at **`<PROJECT_NAME>.pages.dev`** — "or your
  project name plus a few random characters if your project name is already taken"
  (https://developers.cloudflare.com/pages/get-started/direct-upload/). i.e. **names are globally
  unique across all of Cloudflare**, and a collision silently yields a suffixed hostname — so never
  assume the URL equals `<name>.pages.dev`; read it back from wrangler output or the API.
- Practical max length is 58 chars (DNS label 63 minus room for the auto suffix); Cloudflare does not
  publish this figure in the docs — validate defensively with
  `/^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/` and no leading/trailing/double dashes.

### 6. Preview vs production branch semantics (direct upload)

Docs: https://developers.cloudflare.com/pages/get-started/direct-upload/ ,
https://developers.cloudflare.com/pages/configuration/preview-deployments/

- The project has a **production branch**, set at creation (`wrangler pages project create <name>
  --production-branch=main`, or REST `production_branch`). It is a plain string; for direct upload it
  need not correspond to any real git branch.
- `wrangler pages deploy <dir> --branch=<X>`:
  - **`X` == the project's production branch ⇒ PRODUCTION deployment**, served at
    **`<PROJECT_NAME>.pages.dev`** (and any attached custom domains).
  - **`X` != production branch ⇒ PREVIEW deployment.** It gets a permanent per-deployment hash URL
    `<hash>.<project>.pages.dev` **and** a rolling branch alias `<branch>.<project>.pages.dev` that
    always points at that branch's latest deployment. Branch names are lowercased and non-alphanumeric
    chars become hyphens (`fix/api` → `fix-api.<project>.pages.dev`).
- Every deployment — production included — also gets its own immutable `<hash>.<project>.pages.dev`.
- If `--branch` is omitted: inside a git workspace wrangler infers the current branch; outside one it
  cannot, so **always pass `--branch` explicitly in automation**.
- **Decision for this project:** create with `--production-branch=main` and deploy with
  `--branch=main` to always land on the stable `<name>.pages.dev` URL.

### 7. Getting the deployed URL programmatically

- **`wrangler pages deploy` has no `--json` flag.** The documented flags are only `--project-name`,
  `--branch`, `--commit-hash`, `--commit-message`, `--commit-dirty`, `--skip-caching`, `--no-bundle`,
  `--upload-source-maps` (plus the global `--config`, `--cwd`, `--env`, `--version`).
  Doc: https://developers.cloudflare.com/workers/wrangler/commands/pages/
- It prints a human-readable success line ending with the deployment URL, e.g.
  `✨ Deployment complete! Take a peek over at https://<hash>.<project>.pages.dev`.
  Parsing stdout works but is brittle across wrangler versions.
- **Robust options (prefer these):**
  1. `npx wrangler pages deployment list --project-name=<NAME> --environment=production --json` — this
     command **does** support `--json`; take the newest entry and read its `url` (and `id`,
     `environment`, `latest_stage.status`).
  2. `npx wrangler pages project list --json` — returns projects including the canonical
     `subdomain` / `domains` for the project, which is the authoritative `<name>.pages.dev` even when a
     name collision added random characters.
  3. REST `GET /accounts/{account_id}/pages/projects/{project_name}` → `subdomain`, `domains`; and
     `GET …/deployments` → per-deployment `url`.
- **Recommended:** run deploy, then resolve the URL via `deployment list --json` / `project list
  --json`; keep a regex on stdout only as a fallback.

### 8. Is a `wrangler.toml` / `wrangler.jsonc` required?

Doc: https://developers.cloudflare.com/pages/functions/wrangler-configuration/

- **Not required.** CLI flags alone are sufficient for `wrangler pages deploy` (this is the documented
  direct-upload path).
- **Gotchas when a config file IS present:**
  - If a wrangler config file exists in the project, it **must** contain the `pages_build_output_dir`
    key. Without it, wrangler emits a warning that fields are missing and the file "will continue to be
    used for local development only" — i.e. your bindings/vars silently do not apply to the deployment.
  - When `pages_build_output_dir` is set, that value governs what gets uploaded, and Pages "will use
    whatever configuration was defined for local use, which is very likely to be non-production" —
    a real footgun for env-specific config.
  - The config file's `name` field is the Pages project name; passing `--project-name` alongside a
    config with a different `name` is a conflict source. Keep exactly one source of truth.
  - Non-inheritable keys (`vars`, `kv_namespaces`, `d1_databases`, `r2_buckets`, …): if you override
    **any** of them for an environment (`[env.production]` / `[env.preview]`), you must specify **all**
    of them for that environment or validation fails at deploy.
  - Wrangler discovers config by walking up from `--cwd`. In automation, **run wrangler with `--cwd`
    pointed at a directory containing no stray `wrangler.toml`**, or pass `--config` explicitly, so a
    user's unrelated config higher in the tree cannot be picked up.
- **Decision for this project:** go config-file-free; pass everything as CLI flags, and set `--cwd` to
  the asset directory's parent to avoid accidental config discovery.

### 9. Node.js requirement

Doc: https://developers.cloudflare.com/workers/wrangler/install-and-update/ ,
https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/

- "We support running the Wrangler CLI with the Current, Active, and Maintenance versions of Node.js."
- Wrangler v4 dropped Node 16 (EOL 2022); the stated v4 floor is **Node.js 18+**, but since v4 tracks
  the Node.js support lifecycle and 18/20 are past EOL by 2026, **require Node.js 22 LTS or newer**
  in `engines` for this project.

---

## Distilled decisions for the plan

1. Shell out to **`wrangler@4`** (devDependency, invoked via pnpm) — do **not** reimplement direct
   upload against the REST API.
2. **Two-step**: ensure project exists (REST `GET`/`POST /accounts/{id}/pages/projects`, or
   `wrangler pages project create`) → then `wrangler pages deploy`. Never rely on deploy auto-creating,
   because it only does so behind an interactive prompt.
3. Spawn wrangler with env `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WRANGLER_SEND_METRICS=false`,
   no TTY, and flags `--project-name`, `--branch=main`, `--commit-dirty=true`.
4. Resolve the final URL from `wrangler pages project list --json` / `pages deployment list --json`
   (or REST), not from stdout scraping.
5. Validate the project name client-side (lowercase alnum + dashes, ≤58) and surface that the real
   hostname may differ if the global name was taken.
6. Token doc for the user: Account → Cloudflare Pages → Edit (+ optional Account Settings → Read).
