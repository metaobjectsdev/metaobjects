# FR: Parameter-passing for generated repo helpers (`db` as first arg)

**Status:** Design proposal — needs brainstorm before implementation
**Date:** 2026-05-25
**Scope:** Cross-language design decision; TypeScript impl first (`@metaobjectsdev/codegen-ts`)
**Origin:** Friction observed in a downstream consumer adopting 0.6.0 on Cloudflare Workers,
where per-request DB bindings make the current module-level `db` import unworkable. The
underlying design question — "does the generated CRUD helper take a `db` argument, or
import it from a known module path?" — is cross-language: every port's codegen makes
the same choice.

## Current state

Generated `<Entity>.queries.ts` (TS, see `codegen-ts/src/templates/queries.ts`) emits:

```ts
import { db } from "../db";
// ...
export async function findCouncilById(id: string) {
  return db.select()...
}
```

The `../db` module path is consumer-provided. The codegen assumes a singleton, module-level
`db` instance exists at that path.

This works in:
- Long-lived Node.js / Bun processes (the `db` is created once at boot).
- Server runtimes where the DB connection is process-scoped (Postgres pool, libsql client).

This fails in:
- **Cloudflare Workers / Vercel Edge / Deno Deploy.** The DB binding (`env.DB`) is
  request-scoped — there is no module-level `db` to import. Consumers ship a
  runtime-throwing stub purely to satisfy the typecheck:
  ```ts
  export const db = (() => {
    throw new Error("type-only stub — use getDb(env) in the handler");
  })() as unknown as BaseSQLiteDatabase<...>;
  ```
  Every Worker adopter pays this dead-code tax forever.
- **Multi-tenant servers** where each tenant has its own DB connection.
- **Test isolation** where each test wants its own in-memory DB.

The idiomatic 2026 ORM-helper pattern (current Drizzle docs, Kysely, Prisma, TypeORM,
Knex) is parameter-passing. We're the outlier.

## Goal

Generated CRUD helpers take a `db` instance as the first argument. Module-level `db`
imports are no longer required:

```ts
// Generated <Entity>.queries.ts (after this FR)
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export async function findCouncilById(
  db: BaseSQLiteDatabase<"async", { rowsAffected: number }>,
  id: string,
): Promise<Council | null> {
  const [row] = await db.select().from(councils).where(eq(councils.id, id));
  return row ?? null;
}
```

Consumer call sites pass their request-scoped (or module-level) `db`:

```ts
// Worker handler
const db = drizzle(env.DB, { schema });
const council = await findCouncilById(db, "abc123");

// Node server (unchanged ergonomics)
const db = drizzle(pool, { schema });
const council = await findCouncilById(db, "abc123");
```

## Why this is cross-language

The same design choice exists in every port's codegen:

| Port | Today's choice (probably) | Idiomatic 2026 |
|---|---|---|
| TypeScript (codegen-ts) | module-level `db` import | parameter-passing |
| C# (`MetaObjects.Codegen`) | `AppDbContext` constructor-injected (EF Core idiom) | already parameter-passing-ish via DI |
| Java (not yet shipped) | Spring `@Repository` injection | per-Spring convention |
| Python (planned post-H3) | SQLAlchemy session factory or module-level | parameter or context |

C# already gets this right via DI. TypeScript is the obvious gap. The cross-language
spec should:
1. Declare that generated repo helpers take their persistence-context as a parameter
   (or via equivalent idiom: constructor injection for OO ports, `db` arg for functional).
2. Document the per-port acceptable shapes.
3. Let each port migrate at its own pace.

## Brainstorm topics (open)

These need a brainstorm before implementation:

### 1. Migration path for existing 0.6.0 TypeScript consumers

Three options:

**(a) Hard break in 0.7.0.** Consumers update every call site. Clean, predictable, but
forces a single coordinated cut for any active codebase. Documented in CHANGELOG.

**(b) Soft transition: emit both shapes for one release.** Generated code includes:
```ts
// Legacy module-level import (deprecated; remove in 0.8.0)
import { db as _db } from "../db";
export async function findCouncilById(db: BaseSQLiteDatabase = _db, id: string) { ... }
```
Consumers migrate at leisure. Cleanup is automated in 0.8.0.

**(c) Codegen config flag: `queriesShape: "module-db" | "param-db"`.** Default flips to
`param-db` in 0.7.0; consumers can opt back briefly. Aligns with the existing
`columnNamingStrategy` precedent.

Recommendation hypothesis: **(c)** — least disruptive, follows existing config-flag idiom,
default flip in 0.7.0 with a CHANGELOG entry. But brainstorm should confirm.

### 2. Type-only signature for the `db` parameter

For Drizzle specifically: `BaseSQLiteDatabase<"async", { rowsAffected: number }>` is the
narrowest shape covering both libsql and D1. For Postgres it's `NodePgDatabase` (or its
generic). Codegen needs to emit the dialect-correct type — already known from
`config.dialect`. Worth a small design note on how this type is imported (deep import
from `drizzle-orm/*-core` vs. re-exported through a shim).

### 3. Cross-port write-up timing

TS implementation in 0.7.0 is concrete and we have the consumer pain to motivate it.
Should the cross-language design land alongside, or as a follow-up after TS proves the
shape? Recommendation: **TS first, cross-language doc in `spec/decisions/ADR-XXXX-...md`
as TS lands**, so other ports inherit the rationale without blocking TS work.

## Out of scope (until brainstorm)

- Touching `meta init` defaults to remove the consumer's expected `src/db/db.ts` from
  scaffold (will follow once the codegen change is in).
- Removing the `dbImport` codegen config field (still useful for cross-target imports
  unrelated to this change).
- Routes codegen (separate Generator). The `routesFile()` generator imports the same
  `db` via the queries module — once queries take `db` as a param, routes accept the
  same and forward it. Mechanical fallout.

## Tests required when this lands

- `codegen-ts/test/templates/queries.test.ts` — every generated CRUD helper has `db` as
  its first parameter.
- Golden snapshot updates in `codegen-ts/test/golden/__snapshots__/{sqlite,postgres}/`.
- A new conformance check (or extension of existing one) verifying the parameter shape
  across dialects.

## Open questions

1. What is the public commitment around backward compat between 0.6.x and 0.7.0? Hard
   break or soft transition?
2. Should `@metaobjectsdev/runtime-ts` repo helpers (Kysely-based) follow the same
   pattern? Currently they take `db` already, so the runtime side is consistent. The
   gap is purely in codegen.
3. Should this design extend to the routes generator (Fastify route registrar) so
   request-scoped DBs flow through the entire generated stack? Probably yes — Workers
   adopters need this end-to-end.
