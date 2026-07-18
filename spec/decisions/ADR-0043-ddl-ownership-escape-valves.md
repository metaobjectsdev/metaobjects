# ADR-0043: DDL-ownership escape valves (`@sql` body + `@unmanaged` marker)

## Status

**Accepted** (2026-07-17). Implements FR #208 (chartered as the #195 follow-up (a)). Applies the ADR-0037 vocabulary-expansion framework; composes with the projection/view model (ADR-0028), the source-v2 paradigm (ADR-0007), and the TS-owns-schema split (ADR-0015).

## Context

A projection's view body is **synthesized** from its `origin.*` children through the one canonical view-SQL emitter (`build-projection-views.ts`). This is the right default — a projection's `CREATE VIEW` is derived from the model, so a hand-written view is drift. But two cases have no home:

1. **A genuinely-irreducible view.** Some read models cannot be expressed as `origin.*` (recursive CTEs, window functions, lateral joins, vendor-specific SQL). Today the author's only recourse is to hand-write the view *outside* the tool — where it degrades to **accidentally unmanaged**: `meta migrate` neither owns nor emits it, and `meta verify --db` cannot drift-check it.

2. **The silent-wrong-synthesis hole.** The moment such a hand-bodied view declares its lineage — an `extends`-bound `identity.primary` for row identity, or `extends`-bound fields for shape — `viewIsDerived()` flips **true** and the tool **synthesizes a wrong body** (a trivial base-table passthrough `SELECT`) in place of the author's intended SQL. That silent-wrong-synthesis is worse than an abort.

Separately, an author may want a DB object (a view **or a table**) whose DDL is owned entirely **elsewhere** — a Flyway migration, a hand-run script — so `meta migrate` must never create, drop, or drift-check it.

These are the two non-default states of **one axis: who owns a DB object's DDL** — `derived` (default; the tool synthesizes) · `supplied` (the author writes the body, the tool manages its lifecycle) · `external` (someone else owns the DDL).

## Decision

### 1. Two attributes on `source.rdb`, one axis

- **`@sql`** (string) — a hand-written body the tool **registers, fingerprints, and drift-checks but never authors or parses**. The body goes *inside* `CREATE <kind> <physicalName> AS …` — never the `CREATE` wrapper, never the object name.
- **`@unmanaged`** (boolean) — this object's DDL is owned elsewhere; the tool never touches it.

They are **mutually exclusive** on a single source ("emit + fingerprint this" contradicts "never touch this"). Both are attributes on `source.rdb` (ADR-0007 — physical concerns live on the source child), so granularity is **per-source**: a write-through entity can keep its table managed while marking only its read-view source `@unmanaged`.

### 2. ADR-0037 rationale — why attributes, not a subtype or a `@kind`

- `@sql`: **physical-only** (Step 1, decisive) — the body changes no native type and no logical meaning; the projection's declared fields still type the read model and the wire contract is untouched. It is a pure physical-DDL payload, the same category as the existing `@where`/`@expr` raw-SQL escapes. Not a subtype (still an RDB view, no distinct native type/behavior/child vocabulary); not a `@kind` (a hand-bodied view is still `@kind: view` — DDL-provenance is a *second* axis, and folding it into `@kind` makes `@kind` the ADR-0037-forbidden catch-all). Name `@sql` (not `@sqlView`, which is view-specific and self-contradictory on a matview; not `@ddl`, which implies the full `CREATE` wrapper; not `@body`) generalizes by pattern — a future non-RDB paradigm subtype registers its own body attr.
- `@unmanaged`: tool-lifecycle **configuration** → attribute (Step 2c). A boolean exception-flag (the common case is absent). Rejected `@managed: false` (2c forbids a default-true opt-out) and an enum (`@lifecycle`), since the "supplied" state is already carried by `@sql`'s presence.

### 3. The suppression rule (the load-bearing, non-deferrable piece)

An `@sql`- or `@unmanaged`-marked read source **suppresses derivation-classification entirely**: DDL-ownership is classified **before** `viewIsDerived`. This is what lets an escape-valve host legally carry `extends`-bound fields and a borrowed `identity.primary { extends: "Base.id" }` as pure shape / row-identity declarations *without* the tool mis-synthesizing a body. ADR-0028's "self-declared under external assembly" already licenses these declarations — no ADR-0028 change needed.

### 4. Cross-port scope split

- **All five ports** (TS / C# / Java / Kotlin / Python): register the two attrs on `source.rdb`; resolving `MetaSource` accessors (`sqlBody`/`isUnmanaged` etc., following the `@role`/`effectiveKind` *resolving* precedent — **not** the `@dbColumnType` own-only exception, ADR-0039); and the six fail-closed loader-validation rules (§5). The five **error** rules (R1–R5) are conformance-gated by shared `fixtures/conformance/` error-fixtures (every port emits the same code per rule); the R6 **WARN** is per-port unit-tested (the conformance corpus has no warn-fixture mechanism). Java's loader is fail-fast-per-pass (throws on the first violation) versus TS/C#/Python's collect-all — a pre-existing loader-architecture difference, invisible to the single-violation conformance fixtures.
- **TS-only** (ADR-0015 — schema is TS-owned): all migrate/verify *lowering* — the `@sql` verbatim-emit + fingerprint + adopt-view ceremony, and the `@unmanaged` skip + act-side silencing.

### 5. Loader validation — six fail-closed rules (cross-port)

| # | Rule | Code |
|---|------|------|
| R1 | `@sql` **and** `@unmanaged` on the same source | `ERR_SQL_BODY_WITH_UNMANAGED` |
| R2 | `@sql` on a writable `@kind` (`table`) | `ERR_SQL_BODY_ON_WRITABLE_KIND` |
| R3 | `@sql` present but empty/whitespace | `ERR_BAD_ATTR_VALUE` |
| R4 | `origin.*`-bearing field under an `@sql` host | `ERR_ORIGIN_UNDER_SQL_BODY` |
| R5 | `object.projection` `@filter` (#207) + `@sql` host | `ERR_ORIGIN_UNDER_SQL_BODY` |
| R6 | `origin.*`-bearing field under an `@unmanaged` host | **WARN** `WARN_ORIGIN_UNDER_UNMANAGED` |

The R4-error / R6-warn asymmetry is deliberate: `@sql` is a second body (two sources of truth for the *same* data); `@unmanaged` acts on nothing, so a documented-but-unacted-on lineage is benign. `@sql` (R4) takes priority over `@unmanaged` (R6) when a host declares both markers across different sources.

### 6. Migrate lowering (TS-only)

- **`@sql`** rides the *existing* pipeline: push a verbatim `ExpectedView` (`name`=physicalName, `sql`=the verbatim body, `dependsOn`=the `extends`-bound anchor tables, `columns` **omitted**). `buildExpectedSchema` fingerprints `v.sql`; emit stamps the COMMENT marker; an absent `columns` makes the diff fail safe to a gated drop+create instead of a wrong `CREATE OR REPLACE`. A pre-existing **unstamped** view at the name is `replace-view` **blocked pending `migrate --allow adopt-view`** — the one-time adoption ceremony. `@sql` on a non-`view` kind (matview/proc/tableFunction) is an actionable hard error (D4 — not yet migrate-managed).
- **`@unmanaged`** is excluded from both sides: skipped from `expected` (views in `build-projection-views`; tables in `buildExpectedSchema` Pass 1, **but kept in `entityToTable`** so an inbound FK resolves the external table's physical name), and excluded from the introspected `actual` via a `collectUnmanagedNames` set threaded from every diff entry point (online, offline `planOffline`, D1, and `verify`'s `computeDrift`). Net: a declared-external object produces **silence**, not a policy-gated drop. `verify --db` annotates it "external (declared)".

## Consequences

- A genuinely-irreducible view is now **managed-but-opaque**: `meta migrate` owns its lifecycle (emit / fingerprint-drift / gated drop) without ever parsing its body, and the one-time `--allow adopt-view` ceremony adopts a pre-existing hand-written view.
- The "generalizes to any object" half falls out for free: `@unmanaged` on a `@kind: table` is the Flyway-owned-entity case.
- **Documented adopter caveats (not errors):**
  - An FK *from a managed table into an `@unmanaged` table* has no migration-**ordering** guarantee versus the external tool — the external object must exist before the managed FK is applied.
  - An `@unmanaged` view is **not** drop/recreated around a managed dependency's column-altering `ALTER` — the tool has no body for an external view and cannot recreate it; Postgres blocking the `ALTER` is the adopter's signal to coordinate.
  - `@unmanaged` is effectively **non-inheritable** in the migrate lowering: both the expected-side skip and the act-side name-set use own-source detection (so the two halves agree — no split-brain where a table is not created yet is still proposed for drop). Declare `@unmanaged` on the concrete entity's *own* `source.rdb`, not on an `extends` parent's.
- **Deferred follow-ups (filed on the roadmap):**
  - **`@dependsOn` for `@sql` views** — a `@sql` view's `dependsOn` is derived from `extends`-bound anchors only, so a table the opaque body JOINs but does not surface as a bound column is not tracked for auto-recreate around a column `ALTER` (§11 YAGNI — defer the explicit `@dependsOn` attr until an adopter hits it).
  - **The matview managed path** — `@sql` on `@kind: materializedView` needs `pg_matviews` introspection + COMMENT-on-matview plumbing + a REFRESH story.
  - **Opaque-body column-name verification** — PG exposes an `@sql` view's output columns via `information_schema.columns`, so `verify` could eventually column-name-check an opaque body against the declared field set.
