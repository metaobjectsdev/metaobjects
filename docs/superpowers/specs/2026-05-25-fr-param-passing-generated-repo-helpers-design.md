# FR: Parameter-passing for generated repo helpers

**Status:** Design — implementation-ready (plan-of-record)
**Date:** 2026-05-25 (revised after brainstorm)
**Scope:** TypeScript implementation (`@metaobjectsdev/codegen-ts`) + a docs recipe; the
cross-language design principle is captured separately in
[ADR-0008](../../../spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md).
**Depends on:** existing `queriesFile()` codegen pipeline; nothing else.
**Breaking change for:** 0.6.0 → 0.7.0 TS consumers — every call site that invokes a
generated `<Entity>.queries.ts` helper updates from `findUserById(id)` to
`findUserById(db, id)`. Migration is mechanical (search-and-replace at call sites; run
`meta gen` to update the generated files).

## Goal

Generated CRUD helpers in `<Entity>.queries.ts` accept their Drizzle persistence-context
as the first parameter. The module-level `import { db } from "../db"` they emit today is
removed.

```ts
// Before (0.6.0)
import { db } from "../db";
export async function findUserById(id: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u ?? null;
}

// After (0.7.0)
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
type Db = BaseSQLiteDatabase<"async", Record<string, never>>;

export async function findUserById(db: Db, id: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u ?? null;
}
```

## Why

The module-level singleton works in long-lived Node.js / Bun processes (the `db` is
created once at boot). It fails on:

- **Cloudflare Workers / Vercel Edge / Deno Deploy** — the DB binding (`env.DB`) is
  request-scoped; no module-level `db` to import. Today's workers consumers ship a
  runtime-throwing stub purely to satisfy the typecheck.
- **Multi-tenant servers** — each tenant has its own DB connection.
- **Test isolation** — each test wants an in-memory DB.

The idiomatic 2026 ORM-helper pattern (Drizzle, Kysely, Prisma, TypeORM, Knex,
SQLAlchemy 2.x, EF Core via DI) is parameter-passing. We are the outlier. ADR-0008
documents this as the cross-language principle; this FR is the TypeScript implementation.

## Design — minimal scope (Option B from brainstorm)

The brainstorm considered four scopes (queries-only; queries + docs recipe; queries + a
deferred Hono routes FR; queries + dual-target routes generator + runtime-ts split).
Option B — **queries-only + docs recipe** — was chosen because:

- Workers consumers were blocked by module-level `db`, not by the absence of generated
  HTTP routes; they hand-write their HTTP layer regardless.
- Pre-emptively adding a Hono routes generator forces a framework pick (Hono vs itty vs
  raw-fetch vs whatever comes next) that the user base hasn't asked for. The
  consumer-writable `Generator` plugin pattern already lets adopters ship their own.
- `routesFile()` (Fastify) stays unchanged — well-served Node consumers see no
  regression on the routes side.

### What changes

1. **`codegen-ts/src/templates/queries.ts`** — every renderXxxFn() helper
   (`renderFindByIdFn`, `renderListFn`, `renderCreateFn`, `renderUpdateFn`,
   `renderDeleteByIdFn`) gains `db: Db` as the first parameter. No helper has a
   top-level `import { db } from "../db"`.

2. **`codegen-ts/src/templates/queries-file.ts`** — the file composer emits a dialect-
   correct `type Db = ...` alias at the top, then every helper signature references
   `Db`:

   ```ts
   // sqlite/d1 (covers libsql, Turso, Cloudflare D1 — all async sqlite)
   import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
   type Db = BaseSQLiteDatabase<"async", Record<string, never>>;

   // postgres
   import type { NodePgDatabase } from "drizzle-orm/node-postgres";
   type Db = NodePgDatabase<Record<string, never>>;
   ```

   `<Record<string, never>>` for the schema parameter lets consumers narrow the type if
   they want (`drizzle(connection, { schema })`); we don't impose a schema.

3. **Goldens** — all `<Entity>.queries.ts` snapshots regenerated:
   `test/golden/__snapshots__/{sqlite,postgres,package}/*.queries.ts`. The
   `UPDATE_GOLDEN=1 bun test` mechanism (per `test/golden/golden-output.test.ts:5`)
   handles regeneration.

4. **Unit tests** — `codegen-ts/test/templates/queries.test.ts` updated. Each renderXxxFn
   test asserts the rendered code (a) declares `db: Db` as first parameter, (b) does
   NOT contain `import { db }`.

### What doesn't change

- `routesFile()` generator — still emits Fastify routes; consumers using it keep their
  wiring exactly as today.
- `@metaobjectsdev/runtime-ts` — untouched. No split into `/core`. Fastify helpers still
  live at `/drizzle-fastify`.
- `entity-file`, `barrel`, `payload-codegen`, `projection-decl`, all other generators —
  no signature change.
- `dbImport` codegen config field — stays (still useful for cross-target entity imports
  unrelated to this change).

## Docs recipe deliverable

The other half of this FR is a consumer-facing docs page at
`docs/recipes/wiring-generated-queries.md`. The page is paste-and-run, ~200-300 lines
including code blocks. Outline:

1. **TL;DR** — generated queries take `db` as the first arg; pass any compatible
   Drizzle instance.

2. **Setting up `db` per dialect** — three subsections:
   - SQLite/libsql/Turso — `drizzle(libsqlClient)` at module init.
   - D1 (Cloudflare Workers) — `drizzle(env.DB)` inside the request handler.
   - Postgres — `drizzle(pool)` at module init or per-request (multi-tenant).

3. **Wiring in Hono** — a 30-line worked example: full CRUD for one entity,
   request-scoped `getDb(c)`, custom auth middleware applied to a sub-app, the
   sub-app mounted at `/api/users`. Hono is chosen as the primary edge example
   because it is the de facto edge HTTP router in 2026, not because the framework
   is blessed — the same pattern works against itty, hono v5, or raw `fetch()`
   handlers with a different import line.

4. **Wiring in Fastify** — equivalent example. Two variants:
   (a) using the existing `routesFile()` generator (unchanged in 0.7.0);
   (b) hand-rolling routes with the generated queries.

5. **Wiring with raw `fetch()` / itty-router** — short minimal example for
   consumers avoiding HTTP framework deps. Shows how the generated queries
   compose with any router.

6. **Composing with custom routes** — pattern showing generated queries +
   hand-written endpoints living together (e.g. generated `findUserById` plus
   custom `POST /users/:id/promote`). Demonstrates the all-or-nothing-per-verb
   property of today's routes generator is non-binding when you use queries
   directly.

7. **Wrapping into your own `Generator` factory** — for consumers who want
   their routes generated, the ~30-line plugin-model factory pattern. This
   doubles as the worked example for the codegen plugin system itself.

8. **Migration from 0.6.0** — three-step guide:
   ```
   bun add -E @metaobjectsdev/cli@0.7.0   # bump
   meta gen                                # regenerate
   # find/replace call sites: findX(args) → findX(db, args)
   ```

9. **Why parameter-passing** — one-paragraph rationale linking to ADR-0008.

The recipe is implementation work; the actual prose is produced by the plan, not this
spec.

## Tests + verification

### Unit tests (codegen-ts)

- `test/templates/queries.test.ts` updated:
  - `renderFindByIdFn` test asserts `db: Db` is the first parameter; `db` symbol is
    typed.
  - Same for `renderListFn`, `renderCreateFn`, `renderUpdateFn`, `renderDeleteByIdFn`.
  - File-level test on `queries-file.ts` asserts the `type Db = ...` alias is emitted
    at the top and the dialect choice produces the correct Drizzle import path.

### Goldens (codegen-ts)

- Regenerate with `UPDATE_GOLDEN=1 bun test packages/codegen-ts/test/golden/`. Affected
  files: ~20 `<Entity>.queries.ts` snapshots across `sqlite`, `postgres`, and the
  `package` layout fixture.

### Runtime integration (runtime-ts)

- `runtime-ts/test/`'s end-to-end suite already exercises a live libsql + a live
  postgres against generated queries. Update the test plumbing so the test creates
  its `db` and threads it through the helper calls (a few lines of test-side change).
  Test bodies confirming behaviour are unchanged.

### Docs validation

- Type-check the recipe code blocks via a small CI helper that extracts the TypeScript
  fenced blocks and runs `tsc --noEmit` against them. Optional if extraction is fiddly;
  human review is acceptable for a v1 recipe.

## Migration story

`bun add @metaobjectsdev/cli@0.7.0` → run `meta gen` → search-and-replace call sites:

| Before | After |
|---|---|
| `findUserById("abc")` | `findUserById(db, "abc")` |
| `listUsers({ ... })` | `listUsers(db, { ... })` |
| `createUser({ ... })` | `createUser(db, { ... })` |
| `updateUserById("abc", { ... })` | `updateUserById(db, "abc", { ... })` |
| `deleteUserById("abc")` | `deleteUserById(db, "abc")` |

CHANGELOG entry covered by the existing
[release-notes FR](./2026-05-25-fr-release-notes-and-naming-convention-docs.md).

Node-server consumers who prefer the old call-site shape write a one-line shim:

```ts
import { findUserById as _findUserById } from "./generated/User.queries";
import { db as myDb } from "./db";
export const findUserById = (id: string) => _findUserById(myDb, id);
```

This is the inverse of the dead-code stub Workers consumers ship today.

## Out of scope

- **New routes generator (Hono, Express, raw-fetch).** A separate follow-on FR ships
  if user demand surfaces. The docs recipe + plugin model are the answer in 0.7.0.
- **Splitting `@metaobjectsdev/runtime-ts` into universal + framework-specific
  subpaths.** Not needed without a new framework target shipping.
- **Per-verb skip mechanism** (`@routes: { create: false }`). YAGNI; today's routes
  generator has the same all-or-nothing property and consumers haven't asked.
- **A new edge-runtime package** (`@metaobjectsdev/runtime-edge`). Workers consumers
  compose generated queries with their framework of choice; no new package needed.
- **Codegen config flag** (`queriesShape: "module-db" | "param-db"`). Rejected
  during brainstorm: dual code paths + dead-code risk on the deprecated branch.
- **Soft transition** (emit both shapes for one release). Rejected during brainstorm:
  generated code uglier than either pure form; doubles snapshot count; defers cleanup.

## File-level change summary

New files:

- `docs/recipes/wiring-generated-queries.md` — the consumer recipe (~200-300 lines).
- `spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md` — cross-language
  ADR (already landed alongside this FR).

Modified files:

- `server/typescript/packages/codegen-ts/src/templates/queries.ts` — all renderXxxFn()
  helpers updated to accept `db: Db` as first parameter.
- `server/typescript/packages/codegen-ts/src/templates/queries-file.ts` — emits
  `type Db = ...` alias at top; drops the `import { db }` line.
- `server/typescript/packages/codegen-ts/test/templates/queries.test.ts` — assertions
  updated.
- `server/typescript/packages/codegen-ts/test/golden/__snapshots__/{sqlite,postgres,package}/**/*.queries.ts` —
  regenerated via `UPDATE_GOLDEN=1`.
- `server/typescript/packages/runtime-ts/test/**` — test plumbing creates `db` and
  passes it to helpers (test-side only, no production code changes).
- `CHANGELOG.md` — 0.7.0 "Breaking" entry under "Changed" describing the migration.
- `server/typescript/packages/codegen-ts/README.md` — link the new recipe.

## Open questions

None — all design decisions settled during brainstorm.
