# Kotlin OMDB facade (`omdb-ktx`) — Design

**Date:** 2026-05-23
**Status:** Design — ready for implementation plan
**Scope:** A thin, idiomatic-Kotlin layer over the existing Java `om`/`omdb`/`core-spring` engine, so a JVM consumer adopting Kotlin gets a native-feeling persistence API **without** rewriting or forking the engine.
**Decision context:** Kotlin↔Java interop means a Kotlin consumer already uses the Java OMDB directly. We deliberately **reuse + wrap** rather than rewrite (a rewrite buys zero functional gain, forks the engine, and costs the dialect drivers + schema engine). Runtime/ObjectManager behavior is **out of cross-language conformance parity scope** (`spec/conformance-tests.md`), so this layer has **no conformance impact** — it is pure ergonomics.

## Goal

Give a Kotlin consumer a first-class Kotlin persistence API over the Java engine: scope-based transactions, reified-generic CRUD, a query DSL, and coroutine support. **No new persistence behavior**; every operation delegates to the Java engine and must behave identically to a direct Java call.

## Non-goals

- **No engine changes.** OMDB internals (`parseField`, mapping-state, drivers, schema engine) are untouched. Engine debts are tracked separately in `docs/superpowers/specs/2026-05-23-fr-003-followup-omdb-engine-debts.md` and fixed in Java (benefiting all JVM consumers).
- **No Kotlin re-implementation of the loader or runtime.** The first-class Kotlin loader port remains a separate, deferred decision.
- **No Kotlin codegen** (idiomatic Kotlin code emission is a separate, larger effort).
- **No conformance fixtures** (runtime is out of parity scope).

## Background — what we wrap

The Java engine (FR-003 Plans 1 & 2, merged) provides: `ObjectManagerDB` (CRUD, queries, bulk), `ObjectConnection`/`ObjectConnectionDB`, `QueryBuilder` + `Expression`/`QueryOptions`, multi-dialect drivers, `SpringObjectConnections` (Spring-`@Transactional`-aware, non-closing), the FQN→class binding registry, and typed jsonb value-objects. The friction for a Kotlin caller: manual connection lifecycle, checked exceptions, constructor-based query building, `CompletableFuture` async, `Class<T>` passing / null-or-throw ambiguity. The facade hides exactly these.

## Location & build (one open decision)

**Recommendation:** add a Maven reactor module **`server/java/omdb-ktx`** built with the `kotlin-maven-plugin`. It is glue tightly bound to the reactor modules (`omdb`, `core-spring`), so joining the reactor gives one `mvn` build, direct `<dependency>` resolution, and no publish/SNAPSHOT dance.

- **Artifact:** `metaobjects-omdb-ktx`. **Package:** `com.metaobjects.omdb.ktx`. **Kotlin/JVM**, JVM target matching the reactor.
- **Alternative (rejected for now):** `server/kotlin/omdb-ktx` as a Gradle module to honor the strict `server/<language>/` convention — but that forces cross-build-tool wiring to consume the Maven artifacts, for a module that is otherwise pure JVM glue. Revisit if/when a broader Kotlin tree (e.g. a first-class loader port) makes a dedicated `server/kotlin/` Gradle build worthwhile.

## Module layout

```
server/java/omdb-ktx/
├── pom.xml                       # kotlin-maven-plugin; deps: metaobjects-omdb, -core-spring
└── src/
    ├── main/kotlin/com/metaobjects/omdb/ktx/
    │   ├── Transactions.kt       # transaction { } / Spring-aware scopes (auto acquire/release)
    │   ├── Crud.kt               # reified-generic find/save/delete extensions, nullable returns
    │   ├── QueryDsl.kt           # receiver-lambda + infix query DSL over QueryBuilder/Expression
    │   ├── Coroutines.kt         # suspend wrappers over the CompletableFuture async API
    │   └── Errors.kt             # (optional) Kotlin exception mapping / Result<T> variants
    └── test/kotlin/              # integration tests (Derby in-memory + Postgres), behavior parity
```

## What it provides

| Surface | Replaces (Java friction) | Hides which OMDB debt |
|---|---|---|
| `transaction(dataSource) { conn -> ... }` + Spring-aware variant via `SpringObjectConnections` | manual `getConnection()`/`releaseConnection()` | the lifecycle anti-pattern, consumer-side |
| `conn.find<Program>(id): Program?`, `conn.save(program)`, `conn.delete(program)` (reified generics) | passing `Class<T>`; null-or-throw ambiguity | ergonomics + null-safety |
| `conn.find<Program> { Program::status eq "active"; orderBy(Program::createdAt, DESC); limit(25) }` | constructor-based `Expression`/`QueryOptions` | ergonomics |
| `suspend fun conn.findAsync<Program>(...)` over the async API | manual `CompletableFuture` handling | coroutine-native consumers |
| *(optional)* `Result<T>` variants / Kotlin exception hierarchy | checked `MetaDataException`/`PersistenceException` | checked-exception friction |

All surfaces delegate to the Java engine; none re-implement persistence logic.

## Slice plan

Each slice ends with green tests.

0. **Module + smoke test** — reactor module wired; one test acquires a connection from Kotlin, round-trips an object via `ObjectManagerDB`.
1. **Transaction scopes** — `transaction { }` (plain: auto acquire/release, release on exception) + Spring-tx-aware variant via `SpringObjectConnections`. *(Biggest ergonomic win; addresses the lifecycle anti-pattern consumer-side.)*
2. **CRUD extensions** — reified-generic `find`/`save`/`delete`/`findById`, nullable returns, over `ObjectManagerDB`.
3. **Query DSL** — receiver lambdas + infix operators + type-safe field references over `QueryBuilder`/`Expression`.
4. **Coroutines** — `suspend` wrappers over the `CompletableFuture` async API.
5. *(optional)* **Exception mapping / `Result` variants.**

## Verification

- Integration tests against **Derby** (fast, in-memory) and **Postgres** (real dialect).
- **Behavior parity:** facade calls produce identical results to direct Java calls (assert against the same fixtures).
- **Transaction tests:** commit, rollback-on-exception, and ambient-`@Transactional` enlistment (Spring variant).
- A small **before/after sample** demonstrating the ergonomics delta (manual-lifecycle Java vs. `transaction { }` Kotlin).
- No conformance fixtures (runtime out of parity scope).

## Risks

- **Scope creep into a rewrite.** Guardrail: every facade function must delegate to the Java engine; "behavior parity" tests fail if logic diverges.
- **Build-tool friction** if later split to Gradle. Mitigated by starting in the Maven reactor; revisit only with a broader Kotlin tree.
- **Async surface maturity.** The `CompletableFuture` API is the dependency; `suspend` wrappers are thin and tested against it.

## Cross-references

- Java engine: `server/java/{om,omdb,core-spring}/`.
- FR-003 design: `docs/superpowers/specs/2026-05-22-fr-003-omdb-persistence-schema-migration-projections-design.md`.
- Engine debts (fixed in Java, not here): `docs/superpowers/specs/2026-05-23-fr-003-followup-omdb-engine-debts.md`.
- Spring-tx connection: `server/java/core-spring/src/main/java/com/metaobjects/spring/SpringObjectConnections.java`.
