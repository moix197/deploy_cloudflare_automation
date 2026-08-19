# Pages projects list endpoint only accepts `per_page=10`, not 25 or 100

## Context

`GET /accounts/{id}/pages/projects` is a standard paginated Cloudflare list
endpoint, so the natural assumption (matching other Cloudflare list
endpoints, and the values wrangler/dashboard tooling typically use) was that
`per_page=25` or `per_page=100` would work, minimizing the number of requests
needed to page through an account.

Confirmed live against this endpoint on 2026-08-18: both `per_page=25` and
`per_page=100` are rejected outright with Cloudflare error code `8000024`
("Invalid list options provided"). Only `per_page=10` was accepted. This
constraint is undocumented — it was found empirically, not read off
Cloudflare's API docs, and may be specific to this endpoint rather than
Pages/list endpoints generally.

## Decision

`src/lib/listProjects.js` hardcodes `PROJECTS_PER_PAGE = 10` and does not
expose it as a configurable option. Because `per_page=10` forces more
round-trips than a larger page size would (up to 10 requests for an
account at the documented 100-project cap), the pagination loop also caps
itself at `MAX_PAGES = 20` — a defensive bound against a misbehaving or
mocked API that ignores the `page` parameter and returns a full page
forever, not a value expected to be hit in real use.

## Rejected alternative

Trying `per_page=25`/`per_page=100` first and falling back to `10` on a
`8000024` error, to reduce request count on any endpoint where the larger
values might actually work. Rejected as unnecessary complexity: the
per-account project cap (100) bounds the total request count to at most 10
even at `per_page=10`, so the round-trip savings from a fallback are small
and not worth the extra failure path.

## Consequence

Any future change to this endpoint's list options (e.g. Cloudflare loosening
`8000024`) is a candidate to revisit `PROJECTS_PER_PAGE`, but until then
`10` is the only value confirmed to work.
