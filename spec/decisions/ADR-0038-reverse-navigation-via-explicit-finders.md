# ADR-0038: Reverse-relationship navigation via explicit FK finders (not lazy collections)

## Status

**Accepted** (2026-06-30). Implements ADR-0036 Wave 4 (which revised the original `@relationName` plan).

## Context

Navigating a relationship in reverse — from the referenced ("one") side to the entities that reference it ("many"), e.g. all `Scene` rows a `GameSession` points at, or all `Message`s that name a `User` as sender — is a common need. Two investigations reshaped how we should provide it:

1. **Today it is inconsistent and partly broken.** Only the **TS** port generates reverse 1:N navigation, as **Drizzle `relations()` entries** (`relation-resolver.ts:107–111`) — a lazy accessor that needs the Drizzle runtime and is N+1-prone if misused. It also has a **collision bug**: the reverse accessor is named after the *source entity* (`variableNameFromEntity(source)`), so two relationships from the same source to the same target emit duplicate keys and silently overwrite. Java/Spring generates **none**; Kotlin/C#/Python only do M:N. So reverse 1:N nav is a TS-only, buggy feature.

2. **Adopters want it and hand-roll it.** A JVM adopter's `SceneRepository` hand-writes `findByGameSessionAndStatus`, `findByGameSessionIdOrderByCreatedAtAsc`, `findCurrentActiveScene(GameSession)` — exactly the reverse-nav queries codegen should provide. Its `GameSession` has **three** FKs to `Scene` (the collision case). A Python adopter has hub entities (`UserProfile` referenced by 10+) that are prime reverse-nav targets.

3. **Lazy collections are the wrong primitive — on two independent grounds** (cross-ORM research): (a) they are **impossible framework-free** — lazy `user.messages` requires the ORM's proxies + an open session (EF proxies, Hibernate persistence context, SQLAlchemy session, Exposed transaction); MetaObjects' generated code runs *without* the framework (scaffold-and-own, ADR-0034), so there is nothing to intercept the field access; (b) they are the **canonical N+1 anti-pattern** — EF Core ships lazy loading off by default, SQLAlchemy points everyone at `selectinload`, Hibernate teams disable Open-Session-In-View. A standard that values performance should not emit the most-criticized pattern.

## Decision

**Generate reverse navigation as explicit, typed FK query methods — not lazy ORM collections.** For each relationship/FK, the *referenced* entity's query surface gains a finder over the *referencing* entity, filtered by the FK field:

- **Single-parent:** `find<SourcePlural>By<FkField>(value)` → one indexed `SELECT … WHERE <fk> = ?`. (e.g. `findGameSessionsByCurrentScene(sceneId)`.)
- **Batched (anti-N+1):** `find<SourcePlural>By<FkField>In(values)` → one `SELECT … WHERE <fk> IN (…)`, the `selectin` shape, for loading the reverse side of many parents without N+1.

**Properties (why this primitive):**
- **Performant by construction** — one indexed query; no N+1, no lazy surprises, no row-multiplying multi-collection JOIN. The batched variant covers the many-parent case.
- **Framework-free** — a plain function/method over the existing query layer; no proxies, no open session. Runs without MetaObjects (ADR-0034).
- **Consistent across all five ports** — a finder is idiomatic everywhere: a TS query function, a C# query method, a **Spring repository finder** (exactly the shape the JVM adopter hand-writes), a Kotlin function, a Python query function. No port is skipped; none needs the lazy-collection idiom.
- **Dissolves the same-pair collision *and* the need for a naming attribute.** The method name derives from `source + FK-field`, which is unique by construction (FK field names are distinct within an entity). The three `GameSession`→`Scene` FKs yield three distinct finders (`…ByCurrentScene` / `…ByLastOpeningNarrativeScene` / `…ByTransitioningFromScene`). **No `@reverseName` / `@relationName` vocabulary is required.**
- **Zero new metamodel vocabulary** — it is pure codegen derived from existing relationship + `identity.reference` metadata. So it does **not** touch the frozen 1.0 vocabulary; it is additive and may ship in 1.0 or after.

**TS specifically:** the buggy lazy `relations()` reverse entry is replaced by (or fixed alongside) the explicit finders, removing the silent-overwrite collision. (Drizzle's relational query API is itself single-query/non-N+1, so a *fixed* relations entry could coexist; but the explicit finder is the consistent cross-port primitive.)

**Eager "parent with children":** if a future convenience loads a parent together with its reverse children, it compiles to the **batched / `selectin` / split-query** shape (Drizzle lateral + `json_build_array`, EF `AsSplitQuery`, SQLAlchemy `selectinload`, Hibernate `@BatchSize`) — never a multi-collection single JOIN (cartesian blow-up).

## Consequences

- Reverse navigation becomes a **uniform, performant, framework-free capability across all five ports**, replacing real hand-rolled adopter repository methods.
- It is **additive and not vocab-freeze-gated** (no new metamodel attribute). The TS collision bug is fixed as a side effect.
- Every reverse FK gets a finder by default (matching repository conventions); an opt-out knob can be added later if generated-surface size becomes a concern — `log`/document rather than silently cap.
- Gated by a cross-port conformance fixture (the generated finder names + the SQL shape) and, where a port boots its generated artifact, an integration check.
- Per ADR-0020, the *capability* is consistent while the *implementation* stays idiomatic per port (repository finder vs query function).
