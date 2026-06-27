# ADR-0008 — Parameter-passing for generated repo helpers

**Status:** Accepted — 2026-05-25
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** `docs/superpowers/specs/2026-05-25-fr-param-passing-generated-repo-helpers-design.md` (TypeScript implementation); `docs/recipes/wiring-generated-queries.md` (TypeScript consumer guide). Connects with [ADR-0001 — Cross-language metadata→native-type binding](./ADR-0001-cross-language-type-binding.md) (the FQN-to-class binding side of the cross-port codegen story).

## Context

Generated repo helpers — CRUD functions (TypeScript), DAOs (Java), repositories (C#),
session-scoped query objects (Python) — need a persistence-context to talk to the
database. Two industry patterns exist:

- **(A) Module-level / process-level singleton.** Generated code imports or references a
  shared `db` object initialised once at process boot. Long-lived servers with a single
  connection pool can use this directly.
- **(B) Parameter-passing.** Generated code accepts the persistence-context as a function
  argument (data-oriented ports) or via constructor injection (OO ports). The caller
  owns context lifecycle.

The TypeScript port shipped (A) through 0.6.0: generated `<Entity>.queries.ts` does
`import { db } from "../db"` and calls module-level methods. This works in long-lived
Node.js / Bun processes but breaks on:

- **Edge runtimes** (Cloudflare Workers, Vercel Edge, Deno Deploy). The DB binding is
  request-scoped — there is no module-level `db` to import. Consumers ship a
  runtime-throwing stub purely to satisfy the typecheck. Every edge adopter pays this
  dead-code tax forever.
- **Multi-tenant servers** where each tenant carries its own connection.
- **Test isolation** where each test wants an in-memory or rolled-back DB.

The C# port (`MetaObjects.Codegen` per CLAUDE.md) ships pattern (B) by way of EF Core's
`AppDbContext` constructor injection — DI is the C# idiom for the same principle.

The dominant 2026 ORM-helper pattern across the broader ecosystem is (B):

- **Drizzle** (TypeScript) — every helper takes the DB instance; documented as the
  preferred pattern across `drizzle-orm/d1`, `drizzle-orm/postgres-js`, etc.
- **Kysely** (TypeScript) — helpers take a `Kysely<DB>` instance.
- **SQLAlchemy 2.x** (Python) — session-bound query objects; sessions are passed.
- **EF Core** (.NET) — `DbContext` is constructor-injected and consumed; not a singleton.
- **TypeORM, Knex, Prisma's accelerate client** — all take the client/context as a
  parameter or method receiver.

The industry trend is driven by the same forces that drove the runtime-reflection
move documented in [ADR-0001](./ADR-0001-cross-language-type-binding.md): modern
deployment shapes (edge isolates, serverless functions, multi-tenant containers) need
explicit lifecycle handles, not implicit globals. Static-analysis tools (AOT compilers,
bundlers, tree-shakers) similarly disfavour module-level singletons because they break
purity and complicate dead-code elimination.

## Decision

**Generated repo helpers in every metaobjects language port accept their
persistence-context as a parameter**, or via the language-idiomatic equivalent:

- **TypeScript** (`@metaobjectsdev/codegen-ts`) — `db` is the first positional argument
  to every generated query helper. The dialect-correct Drizzle base type
  (`BaseSQLiteDatabase<"sync" | "async", …>` for sqlite/d1/libsql; `PgDatabase` for
  postgres — the base class every driver of that dialect extends) is imported at the
  top of the generated `<Entity>.queries.ts` file.
- **C#** (`MetaObjects.Codegen`) — `AppDbContext` constructor injection (the EF Core
  idiom). Already conforms.
- **Java** (when codegen ships) — `@Repository` / Spring Data injection of the DAO's
  `JdbcTemplate` or `DataSource`. Adopters can call generated DAOs via the Spring
  container or instantiate them manually with their own context.
- **Python** (when codegen ships post-H3) — generated repo functions/methods accept a
  SQLAlchemy session (or compatible context) as a parameter. No module-level engine.

Module-level singletons are **not emitted** by any port's codegen output. Consumers who
prefer the old call-site shape can write a one-line shim
(`const find = (id) => _find(myDb, id)`) — the inverse of the dead-code stub edge
consumers ship today.

## Consequences

### TypeScript (immediate)

- Breaking change in 0.7.0 (the next MINOR bump in the pre-1.0 line). See
  `docs/superpowers/specs/2026-05-25-fr-param-passing-generated-repo-helpers-design.md`
  for the implementation FR.
- Existing 0.6.0 consumer call sites update via mechanical search-and-replace:
  `findX(args)` → `findX(db, args)`.
- Node-server consumers can opt back into a singleton-feel via a one-line wrapper.
- Edge consumers (Workers, Vercel Edge, Deno Deploy) drop their typecheck-stub code —
  the original consumer pain.
- Migration tooling: none required beyond the version bump. The codegen output changes;
  consumer call sites are updated by hand.

### C# (conforms today)

- No change required. `AppDbContext` DI already implements the principle.

### Java (when codegen ships)

- The future Java codegen target (H4 in the roadmap) MUST emit DAOs that accept a
  `DataSource` / `JdbcTemplate` via constructor injection (Spring convention). Cannot
  emit a hardcoded module-level singleton.

### Python (when codegen ships post-H3)

- The future Python codegen output MUST emit repo functions/methods that accept a
  SQLAlchemy session (or compatible context) as a parameter.

### Consumer guidance (cross-port)

- Consumer-facing documentation in each port explains the param-passing call site and
  shows wrappers for the singleton case. TypeScript's
  `docs/recipes/wiring-generated-queries.md` is the reference recipe; other ports
  produce their own when their codegen ships.

### Cross-port compatibility

- Different ports can be at different points in the rollout. C# is already there; TS
  adopts in 0.7.0; Java and Python adopt when their codegen ships. Conformance fixtures
  do not encode call-site shape (they describe metadata, not generated code), so
  staggered adoption introduces no conformance drift.

## Alternatives considered

### Alt 1: Keep module-level singletons; teach edge consumers a workaround

Rejected. The workaround is a runtime-throwing stub that exists purely to satisfy the
typecheck — dead code that every edge adopter ships forever. The "cost" of the
parameter-passing pattern (an extra arg at every call site) is paid by the consumer
who is best-positioned to absorb it; the workaround penalty is paid by an entire
deployment-runtime class. Wrong locus.

### Alt 2: Codegen config flag (`queriesShape: "module-db" | "param-db"`)

Rejected during the TypeScript brainstorm. Two production code paths means dual
maintenance, dual goldens, and a slowly-rotting "deprecated" branch — eventual cleanup
work the project doesn't owe itself.

### Alt 3: Soft transition (emit both shapes simultaneously for one release)

Rejected during the TypeScript brainstorm. Generated code that takes
`db = defaultModuleLevelDb` as an optional parameter is uglier than either pure form,
doubles snapshot count, and defers — not avoids — the breaking-change conversation.

### Alt 4: Factory function `(getDb) => helpers`

Rejected. Adds an abstraction layer the call site doesn't need. Equivalent ergonomics
are recoverable with a one-line consumer wrapper if desired. The factory pattern
hides the lifecycle decision rather than making it explicit, which is the opposite of
what the principle aims for.

## References

- TypeScript implementation FR: `docs/superpowers/specs/2026-05-25-fr-param-passing-generated-repo-helpers-design.md`
- TypeScript consumer recipe (to be written during implementation): `docs/recipes/wiring-generated-queries.md`
- ADR-0001 — Cross-language metadata→native-type binding: `spec/decisions/ADR-0001-cross-language-type-binding.md`
- Industry pattern surveys: Drizzle ORM docs (`/d1`, `/node-postgres`); Kysely; SQLAlchemy 2.x ORM; EF Core context lifetime; TypeORM repository pattern.
