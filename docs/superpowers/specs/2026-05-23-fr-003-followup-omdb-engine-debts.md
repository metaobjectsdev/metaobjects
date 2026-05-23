# FR-003 follow-up — OMDB engine debts (remediation backlog)

**Date:** 2026-05-23
**Status:** Backlog — ready to turn into a plan (intended for near-term work, not deferred)
**Relates to:** `docs/superpowers/specs/2026-05-22-fr-003-omdb-persistence-schema-migration-projections-design.md`, [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md)
**Scope:** Engine-internal OMDB anti-patterns that FR-003 deliberately *contained but did not cure*. Captured here as actionable items because we intend to fix them soon.

## Context

FR-003's stated policy was to **"avoid deepening"** OMDB's known anti-patterns (harvest the engine, don't worsen the smells) — *contain, not cure*. Verified against the merged code (Plans 1 & 2), three debts remain:

- These are **engine-internal** and fixable **in Java** — every JVM consumer (Java *and* Kotlin via interop) benefits from one fix.
- The planned **Kotlin OMDB facade** hides the *ergonomic* residue (lifecycle, checked exceptions) from Kotlin consumers, but a facade sits on top and **cannot** fix these internals. Kotlin syntax does not address them.
- Two of the three are *behavior-preserving refactors*; the existing OMDB integration test suite is the guardrail (runtime is out of cross-language conformance scope, so the corpus does not gate these).

## Debt 1 — `parseField()` if/else type ladder

- **Problem.** Result-row → field value mapping dispatches on field type through an if/else (type-ladder) rather than polymorphically. Adding a field subtype (or dialect quirk) means editing the ladder — the expression problem ADR-0002 exists to remove.
- **Evidence.** `server/java/omdb/src/main/java/com/metaobjects/manager/db/ObjectManagerDB.java:432` (`protected void parseField(...)`); mirrored in `GenericSQLDriver`.
- **Impact.** Maintenance + extensibility tax that scales with field-type and dialect growth. Directly contradicts ADR-0002 (behavior on the class).
- **Proposed fix.** Move read/write value behavior to per-subtype dispatch — either onto the field node class (ADR-0002 shape) or a driver-level type-handler registry keyed by `(subType, dialect)`. Behavior-preserving.
- **Priority.** **High** if field types / dialects grow; medium otherwise.
- **Risk & guardrails.** Behavior-preserving refactor; OMDB round-trip integration tests (Derby + Postgres) are the guardrail. No wire/metadata change.

## Debt 2 — Mapping state cached on `MetaObject` instances

- **Problem.** Per-load DB mapping state is cached on shared `MetaObject` metamodel instances — runtime state living on the (conceptually immutable, shared) metamodel. Layering smell, and a **potential thread-safety/correctness concern under a concurrent server** (the loaded metamodel is shared across requests).
- **Evidence.** Mapping infrastructure unchanged from legacy: `ObjectMappingDB`, `SimpleMappingHandlerDB`, `MappingHandler` (`server/java/omdb/src/main/java/com/metaobjects/manager/db/`).
- **Impact.** If two requests resolve/mutate mapping state for the same `MetaObject` concurrently, behavior is at risk. Needs verification — treat as a risk to confirm, not a confirmed bug. (Note the prior `polish(fr-003): document registry thread-safety` work — thread-safety is already a live concern in this area.)
- **Proposed fix.** Move the mapping cache off `MetaObject` into a scope that owns request/connection lifetime (the `ObjectConnection`/manager, or a driver-owned cache keyed by FQN). Keep the metamodel read-only.
- **Priority.** **High** for any concurrent server deployment.
- **Risk & guardrails.** Add a **concurrent-load integration test** (N threads loading/mapping the same `MetaObject`) as the regression guard *before* refactoring; then move state and keep the test green.

## Debt 3 — Mandatory manual `getConnection()` / `releaseConnection()` lifecycle

- **Problem.** The base `ObjectManager`/`ObjectConnection` API requires callers to manually acquire and release connections. Error-prone (leak on exception paths).
- **Evidence.** `getConnection`/`releaseConnection` across `ObjectManagerDB`, `om/ObjectManager`, `om/QueryBuilder`.
- **Partial mitigation already shipped.** Plan 2's `SpringObjectConnections` (`server/java/core-spring/.../SpringObjectConnections.java`) hands Spring the lifecycle, so **Spring consumers are already covered**. The gap is **non-Spring** callers.
- **Proposed fix.** A scope/template method in the engine (`withConnection { }` / `inTransaction { }`) so manual release isn't required for plain callers. (The Kotlin facade provides this for Kotlin consumers regardless; this item closes it for Java non-Spring consumers too.)
- **Priority.** **Medium** (Spring path already mitigated; facade covers Kotlin).
- **Risk & guardrails.** Additive API; existing manual API stays. Leak test on exception paths.

## Suggested sequencing

1. **Debt 2** first if the target deployment is a concurrent server — it's the only one with a potential *correctness* edge. Land the concurrent-load test, then the fix.
2. **Debt 1** next — unblocks clean field-type/dialect growth and aligns OMDB with ADR-0002.
3. **Debt 3** last — lowest urgency given the Spring mitigation and the incoming facade.

## Next step

Promote to an implementation plan (e.g. an "FR-003 Plan 4 — OMDB engine-debt remediation") once prioritized. All three are forward-only, behavior-preserving (1, 3) or behavior-preserving-with-new-guard (2); none touch the metadata wire format or cross-language vocabulary.
