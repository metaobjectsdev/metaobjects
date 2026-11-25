# Migration — a list with no `limit` answers 50 rows (`1.3.0`)

**TypeScript and C#; check any client that reads a whole list.** A generated list route (entity
or projection, on the Fastify, Hono and ObjectManager mounts, and the C# minimal-API entity, TPH and
projection routes) in a project that sets no `api.pagination` used to answer **every** matching row
when the request carried no `limit`.
From 1.3.0 it answers the first **50**, as the Java, Kotlin and Python routes always have. An
explicit `limit` is still served as asked: without `api.pagination` there is no maximum.

A project that sets `api.pagination` (every project `meta init` has scaffolded since the setting
shipped) sees no change: its `defaultLimit` and `maxLimit` apply as before.

## What to change

| Before | After |
|---|---|
| `GET /api/items` returns the whole table | it returns 50 rows; send `?limit=N`, or page with `offset` and `withCount=1` |
| a client that reads `rows.length` as the total | read `total` from `?withCount=1` |
| `meta verify` or `dotnet meta verify --codegen` advises `unbounded-list-pages` | the advisory is gone: the lists are bounded |
| C#: `?limit=abc` or `?offset=-1` is ignored | it is `400 pagination.invalid_value`, as it already was with `api.pagination` set |

The generated TanStack list hooks are not affected: the grid hook always sends a `limit`.

**An owned runtime copy** (copied by `meta eject routes` or `meta eject routes-hono`) keeps the behaviour of the copy you took. Take a
fresh copy with `meta eject routes --force` (or `routes-hono`) to get the default, or change `pageLimit` in your
copy's `drizzle-fastify/list-params.ts`. In C#, an owned copy of the routes generator (`dotnet meta eject
routes`) keeps writing what it wrote; take a fresh copy with `--force`, or change `WriteOffsetLimit` in it.
Regenerate (`dotnet meta gen`) to move the packaged routes onto the default.

To keep a larger default page, set it:

```json
{ "api": { "pagination": { "defaultLimit": 500, "maxLimit": 5000 } } }
```

## Why

The default page size is 50 in every port (the REST standard, `docs/features/api-contract.md`),
and a list that returns the whole table is a failure waiting for the table to grow.
