# Generated mutation surface — partial patch, optimistic concurrency, and the Kotlin repository generator

**Date:** 2026-07-13
**Status:** Partially implemented. Phase 0 (the forcing-function gate) and the C#/Kotlin
correctness fixes shipped in `7fab436b` (see §10). Phases 2–4 (the typed patch surface + the
Kotlin repository generator) are the active remaining work.

> **OWNER RULING (2026-07-13): `@rowVersion` / ADR-0043 is DECLINED.** Optimistic concurrency
> stays out of the vocabulary. Rationale (ADR-0023 §"can't-be-computed" fails): `@autoSet:onUpdate`
> is already registered with the semantics *"stamps on every write,"* and the legacy OMDB engine
> already derives its optimistic-lock column from exactly that field (`getDirtyField()` — explicit
> attr override, else the auto-on-update field). A new `@rowVersion` attribute would be a second
> name for a concept the metamodel already carries — precisely what ADR-0037 forbids. If a robust
> *counter* token is ever needed (temporal `@autoSet` is unsound on SQLite/D1 at 1-second
> resolution), the move is to widen the existing `@autoSet` to `field.int`/`field.long` (auto-set
> on update ⇒ increment), NOT to add vocabulary. **Phase 5 and PATCH-8 are dropped.** Partial
> update (Phases 0–4) stands alone.
**Issues:** [#197](https://github.com/metaobjectsdev/metaobjects/issues/197) (re-scoped: a generated
Kotlin repository), [#198](https://github.com/metaobjectsdev/metaobjects/issues/198) (no generated
partial/patch update). Both are one root cause: **the generated mutation surface is thin**, so
adopters hand-write exactly the SQL the metadata could own.
**Proposed FR number:** FR-035 (next free slot in `spec/roadmap.md`).
**Ports touched:** all five. Kotlin gets the largest new artifact (a repository generator); C# and
Java get correctness fixes to the generated update handler; TS and Python get typed patch shapes
over already-partial runtimes.
**New ADR proposed:** ~~ADR-0043 (`@rowVersion`)~~ — **DECLINED** by owner ruling (see banner
above). No new vocabulary; no ADR.

---

## 1. Problem statement — the verified ground truth

The premise of this design was re-verified file-by-file on 2026-07-13. Several claims in the
originating issues (and in the initial brief for this document) turned out to be **wrong or
stale**, and the design below is built on what the code actually does. Corrections are called out
explicitly because they change the shape of the work.

### 1.1 What each port's generated mutation surface actually is today

| Port | Generated update, programmatic tier | Generated update, HTTP tier | Partial? |
|---|---|---|---|
| **TypeScript** | `update<Entity>(db, id, data: unknown)` — `InsertSchema.partial().parse(data)` → Drizzle `.set(validated)` (`server/typescript/packages/codegen-ts/src/templates/queries.ts`, `renderUpdateFn`) | Fastify/Hono routes validate with the dedicated `<Entity>UpdateSchema` ("PATCH semantics" — every field optional; `@autoSet onCreate` omitted; TPH discriminator stripped) and mount BOTH `PATCH` and `PUT` (`runtime-ts/src/drizzle-fastify/index.ts`, `mountUpdateRoute`) | **Yes** — at the SQL level, only provided keys are written. Gap: the programmatic signature is `data: unknown` (zero compile-time column safety), and it uses `InsertSchema.partial()` where the routes use the more-correct `UpdateSchema` |
| **Kotlin** | **None. There is no repository generator at all.** `GeneratorRegistry.kt` registers thirteen generators — no `repository`. All data access is emitted inline in the controller | `@RequestMapping(method=[PATCH, PUT]) fun update(id, @Valid @RequestBody dto: <Entity>)` writes **every non-PK column** from a full required DTO (`KotlinSpringControllerGenerator.kt:356-370`) | **No.** A genuinely partial JSON body doesn't even bind: required entity properties are non-null with no default, so Jackson rejects the body before the handler runs (reasoned from the generated data-class shape, `KotlinEntityGenerator.kt:140-144`; not exercised by any test — see §11) |
| **Java** | `SpringRepositoryGenerator` emits an **interface only**: `Optional<Dto> update(PkType id, Dto dto)` — full DTO, consumer implements. OMDB's runtime `updateObject` is **already partial** for `StateAwareMetaObject` classes (writes only modified fields — `ObjectManagerDB.java:735-747`) and even carries a live-but-unreachable optimistic guard (§6.2) | `update(@PathVariable id, @Valid @RequestBody Dto dto)` → `repository.update(id, dto)` (`SpringControllerGenerator.java:276-283`). A partial JSON body binds missing record components to `null`, so the handler cannot distinguish "absent" from "set to null" | **No at the seam.** The runtime can do partial; the generated contract can't express it |
| **Python** | `ObjectManager.update(entity, id, data)` is **already a per-field partial update** ("the PATCH path", `runtime/object_manager.py:270-319`): only keys in `data` are SET, same write codec as INSERT, empty patch = no-op read-back, TPH-scoped | Router passes `dto: dict[str, Any]` through to a repository `Protocol` with `def update(self, id, dto: Any)` (`codegen/generators/router_generator.py:294-307`) | **Yes at runtime; untyped at the seam.** `dict[str, Any]` / `dto: Any` gives no type-checker column safety |
| **C#** | EF Core change tracking: load, set properties, `SaveChanges` emits only changed columns — partial **is** EF's default write path (no generated method needed) | Vanilla entities: `db.Entry(existing).CurrentValues.SetValues(input)` where `input` is a fully-bound CLR object (`RoutesGenerator.cs:191-199`) — **a partial JSON body binds missing properties to CLR defaults and `SetValues` writes those defaults over live data.** The TPH per-subtype handler, by contrast, already does a correct key-by-key JSON partial merge (`RoutesGenerator.cs:439-464`) | **Destructively no at the vanilla HTTP tier** — worse than full-row-stale: absent fields become `null`/`0`/`false`, not even stale reads |

**Corrections to the record** (each verified in code):

1. **#197's stated bug is not real** — Kotlin's generated create already skips a DB-assigned PK and
   returns the assigned key (`KotlinSpringControllerGenerator.kt:334-349`); the issue's own thread
   documents the re-scope. What is real: **no Kotlin repository generator exists**, so the
   row-mapper (`rowTo<Entity>`, emitted inside the controller file) and every finder/mutation an
   application needs outside the HTTP tier is hand-written — the dropped-column drift source.
2. **#198's "the only generated mutation is a full-row update" is false for TS and Python** — both
   have been partial at the SQL level for months (TS since at least 2026-05-18 per
   `git log -L` on `renderUpdateFn`; the persistence corpus's `op: update` is patch-shaped and the
   dedicated `update-delete-all-types.yaml` scenario gates the update write codec). It is **true
   for Kotlin, true at the generated seam for Java, and destructively true for vanilla C#**.
3. The persistence corpus does **not** need a new `op: patch` — `op: update` already carries a
   field-keyed subset (`by:` + `data:`). What's missing is a scenario that patches a **strict
   subset** and asserts the untouched columns, and any concurrency gate at all (§9).
4. The api-contract scenario `update-patch-and-put.yaml` sends a **near-full body on both verbs**,
   which is exactly why the Kotlin/C#/Java handlers pass today despite not supporting partial
   PATCH. The contract corpus never exercises a one-field body. This is the blind spot to close
   first (§9, §10 Phase 0).

### 1.2 The lost-update mechanism, concretely

The hazard the full-row shape creates is not theoretical. Two writers, one row, disjoint concerns:

| t | Writer A (billing service) | Writer B (fulfillment service) | Row state (`status`, `shippedAt`, `paidCents`) |
|---|---|---|---|
| 1 | `GET /orders/42` → `{status: "OPEN", shippedAt: null, paidCents: 0}` | | `OPEN, null, 0` |
| 2 | | `GET /orders/42` → same snapshot | `OPEN, null, 0` |
| 3 | | PUT full row `{status: "SHIPPED", shippedAt: <now>, paidCents: 0}` | `SHIPPED, <now>, 0` |
| 4 | PUT full row `{status: "OPEN", shippedAt: null, paidCents: 4200}` | | **`OPEN, null, 4200`** |

At t=4 writer A meant to change only `paidCents`, but the full-row shape forces it to write back
its stale t=1 snapshot of `status` and `shippedAt` — **B's shipment is silently reverted. No
error, no conflict, no log line.** Under READ COMMITTED (every port's default) nothing in the
database prevents this; it is purely an artifact of the API shape forcing read-modify-write.
A partial update — `SET "paidCents" = 4200 WHERE id = 42` — cannot revert columns it never
mentions, which removes the *disjoint-column* variant of the lost update entirely. The
*same-column* variant (two writers racing on one field) additionally needs a version guard (§6).

### 1.3 The adopter cost

A downstream consumer audited during this investigation hand-wrote **90 single-column mutators
across 6 repositories** (24 / 24 / 19 on the three widest entities) solely because the generated
surface had no partial update — each one a hand-maintained `UPDATE` whose column list can typo,
omit, or drift from the metadata with no gate. The same consumer's Kotlin repositories were
hand-written wholesale because there is nothing to extend (§1.1 row 2), taking the row-mapper —
and thus the entire column mapping — out from under `meta verify`'s protection. This is the
project's core value proposition inverted: the hottest, widest, most-concurrent entities get the
*least* generated coverage.

### 1.4 Why 5000+ tests never caught it

Same lesson as the migrate-engine batch (CHANGELOG 0.15.21): the gates never exercised the failure
shape. `update-patch-and-put.yaml` sends full bodies; `update-delete-all-types.yaml` patches
*nearly every* field (it gates the write codec, not subset semantics); no scenario anywhere sends
a one-field PATCH and re-reads the other columns; no scenario expresses a concurrent-writer
interleaving. Every new gate in §9 therefore follows the hard rule: **apply to a real engine and
re-observe** (Testcontainers PG / the H2 generated-controller lane), never a unit test against
hand-built objects.

---

## 2. Prior art

Full survey with per-tool citations was compiled for this design (WebSearch/WebFetch,
2026-07-13). Condensed here; URLs inline.

### 2.1 The design space

| Tool | Partial update shape | Partial by default? | Optimistic concurrency | Atomic `x = x + 1` |
|---|---|---|---|---|
| **jOOQ** | per-field touched/modified flags on `UpdatableRecord`; `store()` writes only touched columns ([CRUD docs](https://www.jooq.org/doc/latest/manual/sql-execution/crud-with-updatablerecords/), [internal flags](https://www.jooq.org/doc/latest/manual/sql-execution/crud-with-updatablerecords/internal-flags/)) | Yes (TOUCHED mode: an assignment counts even if the value didn't change; MODIFIED mode opt-in, [settings](https://www.jooq.org/doc/latest/manual/sql-building/dsl-context/custom-settings/settings-dirty-tracking/)) | Opt-in setting + configured version/timestamp fields → `WHERE … AND version = ?`, auto-increment, `DataChangedException`; **without** a version field it degrades to `SELECT … FOR UPDATE` + compare ([optimistic locking](https://www.jooq.org/doc/latest/manual/sql-execution/crud-with-updatablerecords/optimistic-locking/)) | via DSL `set(F, F.plus(1))` |
| **Hibernate/JPA** | `@DynamicUpdate` — **opt-in**; default UPDATE writes all updatable columns | **No — the survey's canonical full-row default.** Documented rationale: a stable SQL string enables prepared-statement/plan-cache reuse and JDBC batching ([Vlad Mihalcea forum answer](https://forum.hibernate.org/viewtopic.php?f=1&t=1044154), [blog](https://vladmihalcea.com/how-to-update-only-a-subset-of-entity-attributes-using-jpa-and-hibernate/)) | `@Version` in WHERE + auto-bump → `OptimisticLockException`; versionless DIRTY mode *requires* `@DynamicUpdate` ([locking guide](https://docs.hibernate.org/orm/5.2/userguide/html_single/chapters/locking/Locking.html)) | manual JPQL |
| **EF Core** | change tracker diffs current vs original at `SaveChanges`; SET contains only changed columns ([basic saving](https://learn.microsoft.com/en-us/ef/core/saving/basic), [concurrency doc shows the SQL](https://learn.microsoft.com/en-us/ef/core/saving/concurrency)) | Yes | `[Timestamp]`/`IsRowVersion` (SQL Server rowversion; PG `xmin` via Npgsql), `[ConcurrencyCheck]` app-managed → `DbUpdateConcurrencyException` ([Npgsql](https://www.npgsql.org/efcore/modeling/concurrency.html)) | EF7 `ExecuteUpdate` — but it **bypasses the change tracker and all concurrency tokens** unless manually re-added to the predicate; MS's own docs contain a worked lost-update example from mixing it with tracked saves ([ExecuteUpdate docs](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)) |
| **Drizzle** | `.set(partial)` — only present keys hit SET; `undefined` values silently dropped ([update docs](https://orm.drizzle.team/docs/update)) | Yes (only path) | none built-in; roll-your-own `.where(and(eq(id), eq(version)))` + rowcount | `` sql`${t.x} + 1` `` ([official guide](https://orm.drizzle.team/docs/guides/incrementing-a-value)) |
| **Kysely** | `set()` typed against `Updateable<T>` — all fields optional ([Updateable](https://kysely-org.github.io/kysely-apidoc/types/Updateable.html)) | Yes (only path) | none; manual | `eb('age', '+', 1)` in `set()` callback |
| **Prisma** | `update({where, data})` — `data` partial by default, unspecified fields untouched ([client reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference)) | **Yes — the data model made partial the default from day one** | no `@Version`; documented pattern = `updateMany` with version in `where` + count check ([transactions guide](https://www.prisma.io/docs/orm/prisma-client/queries/transactions#optimistic-concurrency-control)); the 5-year OCC request [#4988](https://github.com/prisma/prisma/issues/4988) was closed by `extendedWhereUnique` (GA Prisma 5), not by a version annotation | `{views: {increment: 1}}` first-class |
| **Exposed** | `Table.update({where}) { it[col] = v }` — only assigned columns in SET ([DSL CRUD](https://www.jetbrains.com/help/exposed/dsl-crud-operations.html)) | Yes (only DSL path) | **none — [issue #630](https://github.com/JetBrains/Exposed/issues/630) open since 2019**; roll-your-own | `it[x] = x + 1` (SqlExpressionBuilder) |
| **SQLAlchemy** | ORM flush writes only dirty attributes (tutorial-demonstrated); Core `update().values(**partial)` ([tutorial](https://docs.sqlalchemy.org/en/20/tutorial/orm_data_manipulation.html)) | Yes (ORM) | mature: `version_id_col` mapper option, version-in-WHERE + bump, `StaleDataError` ([versioning](https://docs.sqlalchemy.org/en/20/orm/versioning.html)); gotcha: Core/bulk updates bypass it | `values(x=t.c.x + 10)` |
| **Django** | `save(update_fields=[...])`; `QuerySet.update(**kwargs)` | **No — plain `save()` writes all columns**; the "why not dirty by default" ticket [#27017](https://code.djangoproject.com/ticket/27017) closed *invalid* | none built-in (third-party django-concurrency) | `F("x") + 1` — the archetype; with the documented double-apply footgun: an `F()` **persists on the instance and re-applies on every subsequent save** ([expressions docs](https://docs.djangoproject.com/en/5.2/ref/models/expressions/#avoiding-race-conditions-using-f)) |
| **ActiveRecord** | dirty tracking; partial updates **default since Rails 2.1 (2008)** — verified in shipped v2.1.0 source (`partial_updates = true`) | Yes, for ~18 years | **built-in by column-name convention**: an integer `lock_version` column activates optimistic locking automatically → `StaleObjectError` ([Locking::Optimistic](https://api.rubyonrails.org/classes/ActiveRecord/Locking/Optimistic.html)); docs recommend carrying `lock_version` through forms | `update_counters` (the instance `increment!` races and is community-flagged) |
| **Diesel** | `#[derive(AsChangeset)]` — `Option` fields skip-if-`None`; `Option<Option<T>>` gives absent/null/value tristate ([guide](https://diesel.rs/guides/all-about-updates/)) | Yes (only path) | none; manual | `.set(x.eq(x + 1))` |
| **Ent** | generated per-column `SetX`/`SetNillableX`/`ClearX` on mutation builders ([CRUD](https://entgo.io/docs/crud)) | Yes (only path) | **"Not available"** (maintainer, [#485](https://github.com/ent/ent/issues/485)); manual version predicate blessed in the [official blog](https://entgo.io/blog/2021/07/22/database-locking-techniques-with-ent/) | `AddX(n)` generated per numeric field |

Cross-cutting: the canonical read-modify-write anti-pattern write-up is Craig Ringer's
["PostgreSQL Anti-patterns: read-modify-write cycles"](https://www.enterprisedb.com/blog/postgresql-anti-patterns-read-modify-write-cycles)
(fix ranking: SQL-side arithmetic → `FOR UPDATE` → **version column in WHERE** → SERIALIZABLE), and
Vlad Mihalcea's [lost-update guide](https://vladmihalcea.com/a-beginners-guide-to-database-locking-and-the-lost-update-phenomena/)
(READ COMMITTED permits lost updates; version-in-WHERE is his recommended fix). At the HTTP layer,
[RFC 7396 JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396) is exactly our patch-body
semantics (present keys replace; the spec's `null`-deletes-member rule is where we deliberately
diverge — §3), and `ETag`/`If-Match` ([RFC 9110 §13](https://www.rfc-editor.org/rfc/rfc9110#name-conditional-requests))
is the HTTP-native analogue of a version column.

### 2.2 What to steal

- **Partial update as the *default* single-row mutation** (Prisma, EF, ActiveRecord, every query
  builder). The two hold-outs — Hibernate and Django — are both full-row for *implementation*
  reasons (plan-cache/batching; dirty-tracking complexity), both are the two most-blogged
  lost-update sources, and Hibernate's own ecosystem recommends `@DynamicUpdate` + `@Version` to
  recover. MetaObjects generates statement-builder code (Drizzle/Exposed/SQL), not a stateful
  entity cache, so Hibernate's plan-cache rationale doesn't even apply to us.
- **ActiveRecord's "one column, by convention, first-class"** for the version token — declared
  once, guarded everywhere, auto-bumped, distinct error type. This maps cleanly onto a metamodel
  attribute (§6).
- **jOOQ's TOUCHED-vs-MODIFIED distinction** — "the caller assigned this column" is the right
  dirty bit, not "the value differs". Our builder/typed-object shapes get this for free: presence
  in the patch *is* the touched flag. Also jOOQ/OMDB's shared re-read discipline: on zero rows
  affected, re-read to distinguish *row gone* (not-found) from *row changed* (conflict).
- **Diesel's absent/null/value tristate** — the patch shape must distinguish "don't touch" from
  "set NULL". JSON gives us this natively (absent key vs `null` value); typed ports need a
  presence-tracking shape, not `null`-means-skip.
- **The empty-patch guard**: Diesel errors on an all-`None` changeset
  ([#885](https://github.com/diesel-rs/diesel/issues/885)), Drizzle throws "No values to set",
  Exposed rejects an empty SET. Python's `ObjectManager.update` already normalizes this to a
  no-op read-back; that becomes the cross-port rule.

### 2.3 What to avoid

- **Hibernate's full-row default** — the exact hazard in §1.2, with 15 years of incident
  literature.
- **EF `ExecuteUpdate`-style set-based writes as the *generated* patch primitive** — it silently
  bypasses concurrency tokens and the change tracker; Microsoft's docs demonstrate the resulting
  lost update themselves. If we ever emit a no-read set-based patch for C#, the version predicate
  must be generated into it, not left to the caller.
- **Django `F()`'s sticky-expression footgun** — a reason to keep atomic expressions *out* of the
  cross-port contract for now (§7) rather than half-ship them.
- **Ent-style per-column setters as the primary surface** (see §4.0) — and Ent/Exposed/Drizzle's
  shared gap of shipping no concurrency story at all, which pushes every adopter to a subtly
  different hand-rolled guard.
- **Timestamp-as-version-token** (OMDB's legacy fallback, jOOQ's timestamp option): same-tick
  writes collide undetected; clock skew lies. Counter only.

---

## 3. The cross-port patch contract

Like the filter grammar (FR-009), the durable artifact is a **semantic contract**, identical in
every port; the surface syntax stays per-port idiomatic (Tier-1 policy — output depends on the
implementation language, so this is native codegen, not the shared TS engine).

**PATCH-1 (subset).** A patch is a set of (field → new value) assignments over an entity's
*settable* fields. Exactly the assigned fields are written; **absent fields are untouched** — the
generated SQL's SET clause contains only assigned columns (single statement; never
read-modify-write).

**PATCH-2 (tristate).** Absent ≠ null. An explicit `null` assignment sets the column NULL and is
valid only for non-`@required` fields (validation error otherwise). This is JSON Merge Patch's
present-key semantics with `null` meaning *set null*, not *delete* — documented divergence from
RFC 7396, matching what all five ports' JSON stacks naturally do.

**PATCH-3 (settable set).** Not settable, ever: the primary key, the TPH discriminator
(immutable — existing rule), `@readOnly` fields, `origin.*`-derived fields, and the `@rowVersion`
field (§6; server-managed). `@autoSet onUpdate` fields are stamped server-side in the same
statement whether or not the caller assigns them; `@autoSet onCreate` fields are not settable via
patch. At the HTTP tier an unknown or non-settable key → 400 with a structured error (matching
the filter-allowlist discipline); at the programmatic tier the typed patch shape simply has no
such member (§5).

**PATCH-4 (validation).** Assigned values run the same per-field validation and the same write
codec as INSERT (the `update-delete-all-types` guarantee, kept).

**PATCH-5 (empty patch).** Zero assignments → no write is executed; the current row is read back
and returned (no-op). Never an error, never an empty-SET SQL exception.

**PATCH-6 (result).** The patch returns the full updated row (RETURNING, or a same-transaction
re-read on engines without it). Missing row → the port's not-found idiom (null/Optional.empty/
404), exactly as today's update.

**PATCH-7 (verbs).** The HTTP tier keeps the existing cross-port shape — `PATCH` and `PUT` both
route to the update handler — but the handler's semantics become PATCH-1..6 (partial merge) on
both verbs. This is already TS's shipped behavior (`<Entity>UpdateSchema` makes every field
optional on both verbs), so it is a bug-fix alignment for Kotlin/Java/C#, not a contract change.
True PUT-as-full-replace is explicitly out of scope (nothing in the corpus or any port ever
implemented it).

**PATCH-8 (guarded patch, §6).** When the entity declares a `@rowVersion` field and the caller
supplies an expected version, the write executes as
`UPDATE … SET …, "version" = "version" + 1 WHERE pk = ? AND "version" = ?`; zero rows → re-read;
row exists → **version conflict** (port-idiomatic error; HTTP 409 `{"error": "version_conflict"}`),
row absent → not-found. Without a caller-supplied expected version the version still bumps but no
guard is added (unguarded partial writes stay lost-update-safe for disjoint columns by PATCH-1).

### 3.1 Choosing the patch shape — three candidates

1. **Builder / statement-lambda** (`repo.patch(id) { it[status] = ACTIVE }`) — one generated
   method; arbitrary column subsets; column identifiers are the *generated table object's*
   properties so rename/drop is a compile error; atomic-expression-capable later. Natural in
   Kotlin (Exposed's `update {}` body *is* this type) and acceptable in TS via a typed object.
   Weakness: in languages without a column-DSL substrate (Java DTO world, Python), there is no
   table object for the lambda to receive.
2. **Per-column setters** (Ent-style `updateStatus(id, v)` / `SetStatus`) — mechanical and
   greppable, but: N methods × M entities of generated surface (the audited consumer's three
   widest entities alone would generate ~70), multi-column patches need chaining or a builder
   anyway (one UPDATE per call would be worse than today), and it invites exactly the
   "one hand-written sibling next to 24 generated ones" drift it should kill. **Rejected as the
   primary surface**; nothing prevents a later opt-in generator for hot single-column paths.
3. **Typed partial object** (Prisma/Kysely `Updateable`-style: a generated type whose members are
   all optional/presence-tracked) — one method, arbitrary subsets, compile-safe against renames,
   and the only shape that works uniformly where there's no column DSL. Weakness: needs explicit
   presence tracking in Java (an `Optional`-boxed builder), and cannot express atomic
   `x = x + 1` (acceptable: §7 defers that).

**Decision: shape 3 is the cross-port default; shape 1 additionally in Kotlin** where Exposed
makes it free (the generated `patch` accepts the Exposed statement lambda — the issue #198 sketch
verbatim). TS's typed partial object doubles as shape 1 in spirit since Drizzle's `.set()` takes
exactly that object.

---

## 4. The generated surface, per port

All sketches below are **generated output** (what an adopter calls), not generator code.

### 4.1 TypeScript (body tier)

TS is already partial; the work is *typing* it and reconciling the two schemas.

```ts
// <Entity>.ts (entity module — zod-validators template)
export const AuthorUpdateSchema = z.object({ /* PATCH semantics — exists today */ });
/** Typed patch shape: every settable field, optional. */
export type AuthorPatch = z.input<typeof AuthorUpdateSchema>;          // NEW

// <Entity>.queries.ts (queries template)
export async function updateAuthor(db: Db, id: number, patch: AuthorPatch): Promise<Author | null> {
  const validated = AuthorUpdateSchema.parse(patch);                    // was: AuthorInsertSchema.partial()
  if (Object.keys(validated).length === 0) return findAuthorById(db, id); // PATCH-5 (Drizzle throws on empty .set)
  const [author] = await db.update(authors).set(validated).where(eq(authors.id, id)).returning();
  return author ?? null;
}
```

Adopter call — a renamed/dropped `status` field is a **TS compile error** at every call site:

```ts
await updateAuthor(db, 42, { bio: "…" });     // writes ONE column
```

Changes: (a) `renderUpdateFn` switches from `InsertSchema.partial()` to `UpdateSchema` — this also
fixes two latent semantic gaps verified empirically on the workspace's Zod 4.4.3: a
caller-supplied `@autoSet onCreate` field (e.g. `createdAt`) is currently *silently replaced with
`now()`* by the InsertSchema transform, and the TPH discriminator is only stripped at the routes
tier, not the queries tier; (b) the parameter narrows from `unknown` to `AuthorPatch` (§5); HTTP
callers still get runtime validation because the routes tier parses with the same schema before
ever reaching this function. (c) the empty-patch guard. The HTTP tier
(`mountUpdateRoute`) is already correct and unchanged. `updateMany(filter, partial)` on the
runtime `ObjectManager` already exists and is untouched.

Naming: the function keeps its shipped name `update<Entity>` — the cross-port contract is the
*semantics* (PATCH-1..8), not the local identifier; renaming to `patch<Entity>` would churn every
adopter for zero behavior change. Ports that must ship a partial method *alongside* an existing
full-row one (Kotlin, Java) name the new one `patch`.

### 4.2 Kotlin (body tier — the new repository generator)

Detailed in §8. The generated call surface:

```kotlin
// generated: AuthorRepositoryBase.kt
open class AuthorRepositoryBase {
    open fun rowToAuthor(row: ResultRow): Author { … }                        // the mapper, reclaimed from the controller
    open fun findById(id: Long): Author? = …
    open fun list(limit: Int, offset: Int, sort: Pair<Column<*>, SortOrder>?, where: Op<Boolean>?): List<Author> = …
    open fun count(where: Op<Boolean>?): Long = …
    open fun insert(model: Author): Author = …        // DB-assigned PK skipped; returns model.copy(id = newId)
    open fun update(id: Long, model: Author): Author? = …                     // full row (existing controller semantics)
    open fun patch(id: Long, body: AuthorTable.(UpdateStatement) -> Unit): Author? = …   // PATCH-1..6
    open fun delete(id: Long): Boolean = …
    // + ADR-0038 reverse finders and FR-018 M:N finders, mirroring the Java interface surface
}
```

Adopter call — the #198 sketch, verbatim:

```kotlin
repo.patch(id) {
    it[status] = Status.ACTIVE
    it[updatedAt] = Instant.now()
}
```

`status` here is `AuthorTable.status: Column<Status>` — generated by `KotlinExposedTableGenerator`
— so a renamed/dropped field is an unresolved-reference **compile error**. With `@rowVersion`
(§6) the generator additionally emits
`open fun patch(id: Long, expectedVersion: Long, body: …): Author` throwing
`VersionConflictException` per PATCH-8.

### 4.3 Java (contract tier + runtime primitive)

`codegen-spring` deliberately emits contracts, not bodies (the consumer picks JPA/jOOQ/JDBC/OMDB).
The generated seam gains a presence-tracking patch type + interface method:

```java
// generated: AuthorPatch.java — presence-tracked; only settable fields exist as members
public final class AuthorPatch {
    public static Builder builder() { … }
    public boolean hasBio();  public String bio();          // present + value
    public boolean hasName(); public String name();
    public Set<String> assignedFields();
    /** Build from a JSON body; unknown or non-settable key -> IllegalArgumentException (controller maps to 400). */
    public static AuthorPatch fromJson(com.fasterxml.jackson.databind.JsonNode body) { … }
}

// generated: AuthorRepository.java (interface — one new method)
Optional<AuthorDto> patch(Long id, AuthorPatch patch);
```

The generated controller's PATCH/PUT handler stops binding the full DTO (which conflates absent
with null — §1.1) and instead binds `JsonNode` → `AuthorPatch.fromJson` → `repository.patch`.
The existing full-DTO `update(id, dto)` stays on the interface for programmatic use.

Runtime note: an OMDB-backed implementation is nearly free — `ObjectManagerDB.updateObject`
already writes **only modified fields** for `StateAwareMetaObject`-backed classes, so
`patch` = load VO → apply assigned fields (dirty-tracked) → `updateObject`. Whether the common
generated/value-object path actually implements `StateAwareMetaObject` needs verification (§11);
if it doesn't, OMDB gains a small explicit primitive
(`updateObjectFields(c, obj, Collection<MetaField>)`) so the generated contract has a body to
stand on.

### 4.4 Python (contract tier over an already-partial runtime)

```python
# generated: author_types.py
class AuthorPatch(TypedDict, total=False):   # total=False == every key optional == presence-tracked
    name: str
    bio: str | None                           # nullable field -> explicit None allowed (PATCH-2)

# generated router Protocol — signature tightens from `dto: Any`
class AuthorRepository(Protocol):
    def update(self, id: int, dto: Any) -> Any | None: ...          # kept (back-compat)
    def patch(self, id: int, patch: AuthorPatch) -> Any | None: ... # NEW
```

The reference implementation is one line — `ObjectManager.update` already implements PATCH-1..6
(subset SET, same codec as insert, empty-patch no-op, TPH scoping, `if_missing`). The
compile-error property is type-checker-level: `mypy`/`pyright` reject a renamed key in an
`AuthorPatch` literal. The FastAPI route keeps accepting `dict[str, Any]` on the wire (runtime
validation via the ObjectManager's unknown-field `ValueError` → 400).

### 4.5 C# (body tier)

Two changes, no new generator:

1. **Fix the vanilla update handler** — replace `CurrentValues.SetValues(input)` with the
   key-by-key JSON partial merge **that the TPH per-subtype handler already generates**
   (`RoutesGenerator.cs:439-464`: parse `JsonDocument`, skip PK/discriminator/unknown, set
   `entry.CurrentValues[target]`). Hoist that emission into a shared helper and use it for both
   branches. EF's change tracker then emits a SET clause of exactly the touched columns —
   partial-by-default is EF's native behavior.
2. **Programmatic tier**: nothing to generate — the idiomatic C# patch *is* the tracked entity
   (`var e = await db.Authors.FindAsync(id); e.Bio = "…"; await db.SaveChangesAsync();`), which is
   already partial and already compile-safe. This gets documented in the generated api-docs
   rather than wrapped. A generated `ExecuteUpdate`-based no-read patch is deliberately **not**
   emitted (concurrency-token bypass, §2.3); revisit only with the version predicate generated in.

### 4.6 Tier summary — who generates a body, who generates a contract

| Port | Patch body | Patch contract | Runtime primitive it stands on |
|---|---|---|---|
| TS | generated (`queries` template) | `AuthorPatch` type | Drizzle `.set()`; runtime-ts `ObjectManager.update` already partial |
| Kotlin | **generated (new repository generator)** | the repo base class | Exposed `update {}` (no separate runtime layer — by design) |
| Java | consumer-implemented | generated interface method + `AuthorPatch` | OMDB `updateObject` (already modified-fields-only) |
| Python | consumer-implemented (reference = 1 line) | generated `Protocol` method + `AuthorPatch` TypedDict | `ObjectManager.update` already partial |
| C# | generated (routes handler fix) | tracked-entity idiom (documented) | EF change tracking |

This respects the tiering policy: everything here is per-port idiomatic native codegen (Tier 1);
no language-neutral artifact is involved.

---

## 5. The compile-error property

The requirement: **a renamed or dropped field must break the adopter's build at every mutation
call site — never silently skip a write.**

| Port | Mechanism | Failure on rename/drop |
|---|---|---|
| TS | `AuthorPatch` = `z.input<typeof AuthorUpdateSchema>` — an object literal with a stale key fails excess-property checking; `tsc` error | compile error (was: none — `data: unknown`) |
| Kotlin | patch lambda receiver is the generated `AuthorTable`; `it[status]` resolves a `Column<T>` property | unresolved reference — compile error |
| Java | `AuthorPatch.Builder.status(...)` is a generated method | cannot-find-symbol — compile error |
| Python | `AuthorPatch(TypedDict, total=False)` | `mypy`/`pyright` error (runtime: ObjectManager raises on unknown field → the write cannot silently target a ghost column) |
| C# | tracked-entity property assignment / generated entity property | CS compile error |

Two caveats stated honestly: (a) TS's excess-property check applies to object *literals*; a
widened variable can smuggle a stale key past `tsc` — but it then fails the runtime
`UpdateSchema.parse` (strip/reject), so the write still cannot silently vanish; (b) Python's
guarantee is only as strong as the adopter's type-checking discipline — hence the runtime
unknown-field rejection stays load-bearing.

---

## 6. Optimistic concurrency

### 6.1 In charter, or app-level? — argued

**Recommendation: in charter, opt-in per entity, as the second phase of this FR.**

For: (1) Partial update removes only the *disjoint-column* lost update; the *same-column*
read-modify-write flow (form editing: read → user thinks → write) still silently reverts, and
that flow is exactly what the generated forms/hooks pillar produces. (2) Every mature ORM that
grew up (Hibernate, EF, SQLAlchemy, ActiveRecord, jOOQ) ships version-token locking first-class;
the ones that don't (Exposed #630 open since 2019, Ent "not available", Drizzle/Kysely/Prisma)
push each adopter to a hand-rolled `WHERE version = ?` — i.e., back to hand-maintained SQL, the
drift class this whole FR exists to kill. (3) It is *pattern-derivable once declared*: guard
clause, bump, conflict mapping, wire round-trip, and the 409 envelope are 100% generatable from
one attribute — squarely "pattern-derivable from metadata = codegen, never hand-code". (4) The
Java port already had the concept: OMDB's `allowsDirtyWrites`/`getDirtyField`/`DirtyWriteException`
(`ObjectManagerDB.java:716-767`) is a live optimistic guard on the modern expression path — but
its driving attributes (`dbAllowDirtyWrite`, `dbDirtyWriteCheckField`) are **absent from
`expected-registry.json`**, so under ADR-0023 strict loading no adopter can even declare them:
proof of demand, currently unreachable.

Against (and why they don't win): "apps can add a version column themselves" — they can, but then
the guard/bump/conflict handling is hand-written N times per port with N subtly different
semantics, and `meta verify` can't see any of it. "It complicates the 1.0 vocabulary freeze" —
real; hence Phase 5 is explicitly severable and gated on the owner ruling; nothing in Phases 0–4
depends on it.

### 6.2 The metamodel change — ADR-0037 walked, in order

Is there an existing version/row-version concept? **No** — verified: `expected-registry.json` has
no such attr (the only `version`-ish entry is the `template.*` governance attr, which is named
`since`, so there is no name collision); the OMDB legacy attrs are unregistered (above).

- **Step 0 — derivable?** No. *Whether* an entity opts into optimistic locking is a business
  decision, not a structural consequence; *which* column is the token cannot be inferred. The one
  candidate derivation — reuse the `@autoSet onUpdate` timestamp as the token (OMDB's legacy
  fallback does exactly this) — is unsound: equal-timestamp writes collide undetected and
  sub-tick concurrency is invisible (§2.3). DB-native tokens (PG `xmin`, SQL Server `rowversion`)
  are not derivable *portably*: SQLite/D1 have no analogue, and the token must round-trip on the
  wire for clients, which system columns don't.
- **Step 1 — physical-only?** No. It changes generated behavior (WHERE guard, auto-bump, a new
  error), the wire contract (the version must be read by clients and echoed back), and the
  caller-settable field set. Logical.
- **Step 2a — own native type/behavior → subtype?** The value is a plain counter (`long`); no
  distinct native type in any port. Its "behavior" is write-path *policy* — exactly the shape of
  `@autoSet` (server-managed value with write-path behavior), which this codebase already models
  as an **attribute**, not a subtype. Prior art agrees: Hibernate `@Version`, EF
  `IsRowVersion`/`[ConcurrencyCheck]`, SQLAlchemy `version_id_col` all mark *an ordinary numeric
  field*; only ActiveRecord uses bare column-name convention (too magical for a strict-provenance
  metamodel). Not a subtype.
- **Step 2b — `@kind`?** No subtype for it to be a variant of.
- **Step 2c — attribute.** A **boolean exception-flag** (the common case is absent): the flag
  marks the exception. ✅

**Proposed vocabulary:** `@rowVersion: true`, registered on `field.long` and `field.int` only
(registration scoping enforces the type constraint for free). Name: not bare `version`
(self-documentation — "row version token", and it sidesteps any future collision with
governance-style version attrs; precedent: EF's `IsRowVersion`). Loader validation (own-only,
per-port, conformance-gated): at most one `@rowVersion` field per entity
(`ERR_BAD_ATTR_VALUE`), not combinable with `@autoSet`/`@readOnly`/PK membership. Registered by
the core field provider (it is wire- and codegen-visible everywhere, not RDB-physical).

### 6.3 ADR-0023 compliance — the can't-be-computed justification and the required ruling

Per ADR-0023, a new attribute needs (1) proof it cannot be computed — given above (opt-in policy
+ token-column identity are not derivable; the derivable candidate, timestamp-as-token, is
unsound); (2) **explicit human agreement — this document is the request; Phase 5 must not start
until the owner rules**; (3) a registered provider + `registry-conformance` fixture in all five
ports (Phase 5 plan, §10) — including the **committed registry copies in the C# and Python ports**,
which have been forgotten before and fail conformance silently per-port.

### 6.4 Semantics and per-port mapping

Declared as:

```jsonc
{ "field.long": { "name": "version", "@rowVersion": true } }
```

- **DDL** (TS-owned, migrate-ts): `BIGINT NOT NULL DEFAULT 1`; adding `@rowVersion` to an
  existing entity is an ordinary add-column-with-default migration.
- **Write paths**: INSERT lets the default apply (or sets 1 explicitly where the port enumerates
  columns); every UPDATE/patch appends `SET "version" = "version" + 1` — an in-SQL bump, never
  read-then-write (this is the one place the design *does* use an atomic expression, generated,
  invisible to callers — Django's `F()` done safely).
- **Guard**: only when the caller supplies an expected version (PATCH-8). Zero rows → re-read by
  PK → conflict vs not-found (the OMDB `DirtyWriteException` re-read pattern, kept).
- **Caller-visibility**: readable on every wire read; excluded from Insert/Patch settable sets.

| Port | Guarded-patch surface | Conflict signal |
|---|---|---|
| TS | `updateAuthor(db, id, patch, { expectedVersion })` (queries) / `WriteOpts.expectedVersion` (runtime OM) | `VersionConflictError` (runtime-ts `errors.ts`) |
| Kotlin | generated `patch(id, expectedVersion, body)` overload | `VersionConflictException` (generated alongside the repo) |
| Java | `Optional<Dto> patch(Long id, long expectedVersion, AuthorPatch p)` on the interface; OMDB impls map `@rowVersion` onto the existing live dirty-field expression path | `DirtyWriteException` (exists) or a new typed sibling |
| Python | `om.update(..., expected_version=)` / Protocol overload | `VersionConflictError` |
| C# | entity property mapped `.IsConcurrencyToken()` in the generated DbContext; handler sets `OriginalValues[version] = expected` and bumps | `DbUpdateConcurrencyException` mapped by the generated handler |

- **HTTP tier**: the version field rides in the normal JSON body on PATCH/PUT; when present the
  handler treats it as the expected version (it is not a settable field, so this does not collide
  with PATCH-3). Mismatch → **409** `{"error": "version_conflict"}` — a new cross-port envelope
  code beside `not_found`. `ETag`/`If-Match` is noted as the HTTP-pure alternative and deferred
  (adds header plumbing to every generated client for the same guarantee).
- **Legacy convergence**: OMDB's `dbAllowDirtyWrite`/`dbDirtyWriteCheckField` attrs stay
  unregistered and are eventually removed; `@rowVersion` becomes the one registered doorway into
  that (already-working) engine path.

## 7. `F()`-style atomic in-place updates — explicitly deferred

`SET counter = counter + 1` is a real adjacent need (the only correct concurrent increment) and
every surveyed tool ships an idiom (§2.1 last column). **Deferred from this FR**, with rationale:
(a) it needs an expression vocabulary in the patch value position (`increment`/`decrement`/… or
raw expressions), which is a cross-port conformance surface an order of magnitude wider than
value assignment; (b) the two shipped shapes already leak it idiomatically where it's safe —
Kotlin's patch lambda accepts `it[views] = views + 1` **today by construction** (Exposed
`SqlExpressionBuilder`), and TS adopters can pass `` sql`${t.views} + 1` `` through Drizzle
directly; (c) the one place the *generated* code needs it — the `@rowVersion` bump — is emitted by
the generator, not expressed by callers. If promoted later, Prisma's typed
`{increment: n}` object is the shape to copy (composes with the typed-partial-object patch;
avoids Django's sticky-`F()` footgun). File as a follow-up issue when this FR lands.

---

## 8. The Kotlin repository generator

### 8.1 Emitted artifacts

New `KotlinRepositoryGenerator` (stable id **`repository`** — the id already exists in
`fixtures/generator-registry-conformance/registry.json` with `ports: ["java"]`; Kotlin is added to
that entry, and the concept line generalizes from "Spring Data repository" to "per-entity
repository seam"). Per concrete writable entity (`source.rdb @kind: table`), one
`<Entity>RepositoryBase.kt`: the row-mapper, `findById`, `list`/`count` (filter/sort-pipeline
compatible), `insert` (PK-skipping + id-returning, per `@generation`), full-row `update`, `patch`
(+ guarded overload under `@rowVersion`), `delete`, ADR-0038 reverse finders, FR-018 M:N finders —
the same method surface as Java's `SpringRepositoryGenerator` interface, **with bodies**. TPH
bases get the polymorphic + per-subtype-scoped variant mirroring `emitTph`; view-kind entities get
a read-only repository (mapper + finders only); `@generation: assigned` entities get an insert
that writes the caller's PK (fixing in passing the never-reads-`@generation` gap found in #197's
re-verification).

Methods are `open` on an `open class`; every Exposed call runs inside
`transaction { }` blocks that join an enclosing transaction (Exposed default), so both
controller-owned and repo-owned transaction boundaries work.

### 8.2 Composition with the existing controller — delegate, accept the golden churn

Today `KotlinSpringControllerGenerator` is deliberately self-contained (the SP-F harness hosts it
with no persistence seam) and owns `rowTo<Entity>` privately. Decision: **the controller delegates
to the repository** — matching the Java port's controller→repository architecture, deduplicating
the row-mapper, and making the repo the single write path (so `@rowVersion`, `@autoSet` stamping,
and patch semantics live in exactly one generated place). Constructor injection:

```kotlin
@RestController
@RequestMapping("/api/authors")
class AuthorController(private val repo: AuthorRepositoryBase) { … }
```

Bean wiring: the generated base is **not** annotated `@Repository` (a consumer subclass would
create an ambiguous second bean). Instead `KotlinSpringConfigGenerator` gains per-entity
`@Bean @ConditionalOnMissingBean(AuthorRepositoryBase::class) fun authorRepository() = AuthorRepositoryBase()`
defaults — a consumer subclass bean transparently replaces the generated default.

The alternative — ship the repository standalone and leave the controller inline — was rejected:
it forks the write path (controller full-row vs repo patch), leaves the mapper duplicated, and
the controller could not pick up the §3 partial semantics without growing its own per-field
dispatch anyway. The churn is one-time and enumerated in §10.

### 8.3 The extension story — no signature clash

#197's clash existed because hand-written repos needed a *differently-typed* insert
(`insertReturning(): Long`) beside an inherited `insert(model): Model`. The generated base removes
the need: `insert(model): Author` returns the model **with the DB-assigned id populated**
(`model.copy(id = newId)`), so there is nothing to add with a conflicting signature. Consumers
extend by subclassing (`class AuthorRepository : AuthorRepositoryBase()`), overriding `open`
methods, or adding hand-written queries alongside inherited generated ones — and they keep the
generated row-mapper either way, which is the drift-protection point. Generated files carry the
`@generated` header and are wholly regenerated; the subclass is the hand-edit surface (same
division as everywhere else in the project — no three-way merge needed for Kotlin).

---

## 9. Conformance

Every gate below runs against a **real engine and re-observes** (§1.4). No new `op` is needed —
`op: update` is already patch-shaped; the additions are scenarios and one DSL key.

1. **`fixtures/persistence-conformance/queries/patch-subset-non-clobber.yaml`** (all 5 ports,
   Testcontainers PG). Seed one row with known values in every column; `op: update` assigning
   subset A; `op: update` assigning a *disjoint* subset B; `op: get` asserting A's columns, B's
   columns, **and the never-touched columns still hold their seeds**. This deterministically
   convicts any full-row engine without threads: a full-row implementation must invent values for
   the columns the patch omits. Also gates PATCH-5 with a trailing empty `data: {}` op asserting
   the row is returned unchanged.
2. **`fixtures/persistence-conformance/queries/rowversion-guard.yaml`** (Phase 5). Requires a
   `@rowVersion` field added to the canonical kitchen-sink metadata + a regenerated committed
   `canonical/schema.postgres.sql` (TS-owned; the drift-check test keeps it honest). New DSL key
   `expectedVersion:` on `op: update`, plus the existing `expect-error` shape gaining
   `code: version_conflict`. The scenario expresses the two-writer interleaving sequentially —
   read (v=1) → writer B patches (v→2) → writer A patches with `expectedVersion: 1` →
   `expect-error: version_conflict` → `op: get` asserts B's write is intact and `version == 2`.
   Sequential ops are a *faithful* encoding here because the guard is a single atomic statement;
   no scheduler could interleave inside it.
3. **`fixtures/api-contract-conformance/scenarios/update-partial-single-field.yaml`** (all 5
   ports, **both lanes** — reference server and the generated artifact over HTTP). PATCH one field
   of the Author; assert 200 and the patched field; GET and assert every *other* field unchanged.
   This is the forcing function: today it fails Kotlin (Jackson binding rejection or full-row),
   vanilla C# (defaults written over live data), and Java (nulls bound over live data), in the
   generated lane where it counts. A second request sets a nullable field explicitly to `null`
   (PATCH-2) and a third sends an unknown key expecting 400 (PATCH-3).
4. **`update-version-conflict-409.yaml`** (api-contract, Phase 5): stale version in the body →
   409 `{"error": "version_conflict"}`; correct version → 200 with bumped version in the response.
   Needs a versioned entity added to the api-contract corpus metadata.
5. **`fixtures/generator-registry-conformance/registry.json`**: `repository.ports` += `kotlin`
   (the both-ways presence check makes forgetting either side a failure).
6. **`fixtures/registry-conformance/expected-registry.json`** (Phase 5): `@rowVersion` on
   `field.long`/`field.int`, synced into the **committed C# and Python registry copies**.
7. **Kotlin's persistence runner re-pointed at generated code**: `integration-tests-kotlin`'s
   `QueryScenarioRunner.dispatchUpdate` is hand-written Exposed today; once the repository
   generator exists, the runner's create/update/delete dispatch should route through the
   **generated repository** (the generate→compile→load pattern the api lane already uses), so the
   corpus finally exercises generated Kotlin mutation code against a real database — closing the
   same "hand-written stand-in satisfies the gate" hole the #197 investigation flagged for the
   Java/Python api lanes.
8. Housekeeping: the stale "PORT STATUS: TS only" note in `update-delete-all-types.yaml` is wrong
   for at least Kotlin and Python (both runners dispatch `op: update` today — verified) and gets
   corrected after re-verifying Java/C#/TS runner status (§11).

---

## 10. Ordered implementation plan

**Phase 0 — contract first (red gates).** Add scenario (3) and scenario (1). Expected state:
TS green both; Python persistence green / api-contract lanes to verify; Kotlin, C#, Java red —
by design. Files: the two YAML fixtures only.

**Phase 1 — C# and Java HTTP-tier correctness.**
- `server/csharp/MetaObjects.Codegen/Generators/RoutesGenerator.cs`: hoist the TPH partial-merge
  emission into a shared private emitter; use it for the vanilla `Update<cls>` handler
  (delete the `SetValues` path). Goldens: `MetaObjects.Codegen.Tests` route snapshots.
- `server/java/codegen-spring/`: new `SpringPatchGenerator.java` (or a `SpringDtoGenerator`
  sibling) emitting `<Entity>Patch`; `SpringRepositoryGenerator.java` interface gains `patch(...)`;
  `SpringControllerGenerator.java` update handler binds `JsonNode` → `<Entity>Patch.fromJson` →
  `repository.patch`. The api-contract **reference** in-memory repos in
  `server/java/integration-tests` implement `patch`. Goldens: codegen-spring generator tests.

**Phase 2 — the Kotlin repository generator.**
- New `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinRepositoryGenerator.kt`;
  registry entry in `GeneratorRegistry.kt`; manifest edit (conformance item 5).
- New snapshot files under `server/java/codegen-kotlin/src/test/resources/snapshots/*` (every
  entity-bearing suite: `single-entity-primitives`, `entity-with-fk`, `entity-with-bidirectional-fk`,
  `entity-with-controller`, `entity-with-tph`, `entity-with-view`, …) + compile-and-run tests
  (the existing kotlin-compile-testing pattern, H2).

**Phase 3 — Kotlin controller delegation.**
- `KotlinSpringControllerGenerator.kt`: constructor-inject the repo; delegate all verbs; delete
  the inline `rowTo<Entity>` and Exposed bodies; PATCH/PUT handler goes partial via `repo.patch`
  driven by a per-field JSON dispatch (the generator already builds exactly this per-field spec
  list for filters). `KotlinSpringConfigGenerator.kt`: `@ConditionalOnMissingBean` repo beans.
- Churn to absorb: controller snapshots across all suites;
  `integration-tests-kotlin/.../api/generated/GeneratedAuthorControllerHarness.kt` (compile + wire
  the repo bean — one more generator in its list); the TPH harness; then conformance item 7
  (runner re-point).

**Phase 4 — TS + Python typed patch seams.**
- TS: `server/typescript/packages/codegen-ts/src/templates/zod-validators.ts` exports
  `<Entity>Patch`; `templates/queries.ts` `renderUpdateFn` switches schema, types the param, adds
  the empty-patch guard (and the TPH branch in `queries-file.ts:273` gets the same treatment).
  Goldens: codegen-ts golden tests + `fixtures/codegen-conformance` TS slices.
- Python: `codegen/generators/entity_model.py` (or sibling) emits `<Entity>Patch` TypedDicts;
  `router_generator.py` Protocol gains `patch` and the route calls it.

**Phase 5 — ~~`@rowVersion`~~ — DROPPED (owner ruling, 2026-07-13).** Optimistic concurrency is
not entering the vocabulary; see the banner at the top. This phase and PATCH-8 are cancelled. If
the need resurfaces, it is handled by widening the existing `@autoSet` to integer fields, tracked
separately — not here.

**Phase 6 — docs.** Tier-2 feature doc (`docs/features/`), generated api-docs mention of patch
semantics per port, agent-context skills note ("use the generated patch — never hand-write a
single-column UPDATE"), roadmap registry row FR-035, and correcting the stale corpus note
(conformance item 8).

Suggested release shape: Phases 0–4 are a coordinated minor across npm/NuGet/Maven (PyPI mostly
test/codegen-seam); Phase 5 is its own coordinated release with the ADR.

---

## 11. Open questions and risks

1. **Owner ruling required (§6.3):** admit `@rowVersion` into the vocabulary? It is the only
   metamodel change in this design; everything else is generator/runtime work under existing
   vocabulary. If declined, PATCH-8 and Phase 5 drop out cleanly; partial update stands alone.
2. **Kotlin partial-body binding is reasoned, not tested:** the claim that a partial JSON body
   fails Jackson binding on the generated non-null-no-default data class (§1.1) follows from
   `KotlinEntityGenerator.kt:140-144` + jackson-module-kotlin semantics, but no test exercises
   it. Phase 0's scenario (3) settles it empirically either way — the handler is wrong in both
   candidate behaviors (400 or full-row).
3. **Java `StateAwareMetaObject` coverage unverified:** which concrete object classes on the
   generated/OMDB path actually implement it (only `ManagedMetaObject` was confirmed as an
   implementor of the pattern; `ValueMetaObject`'s status was not verified). Determines whether
   OMDB-backed `patch` is free or needs the explicit `updateObjectFields` primitive (§4.3).
4. **Per-port `op: update` runner status:** Kotlin and Python verified implemented; the Java, C#,
   and TS integration runners were not re-checked line-by-line against the stale corpus note.
   Verify before editing the note (conformance item 8).
5. **PUT semantics debt:** PATCH-7 canonizes PUT-as-partial-merge (TS's shipped behavior). If a
   true replace verb is ever wanted, it is a *new* contract decision, not a regression here —
   flagged so nobody later mistakes this for an oversight.
6. **Exposed empty-SET detection (PATCH-5 in Kotlin):** the generated `patch` must detect a
   zero-assignment lambda to no-op instead of letting Exposed throw. Expected to be doable by
   inspecting the `UpdateStatement`'s value set after applying the body; if Exposed's API makes
   that awkward across versions, fallback is documenting empty-patch as a caller error in Kotlin
   only (contract deviation — would need calling out in the corpus scenario as a port waiver,
   which is undesirable; spike early in Phase 2).
7. **Golden churn size (Phase 3)** is the largest mechanical risk: every Kotlin controller
   snapshot changes. Mitigation: Phases 2 and 3 are separate commits with the compile-and-run
   tests green between them; the api-contract generated lane gates behavior equivalence across
   the refactor.
8. **Client-web surfaces:** generated TanStack mutation hooks (`useUpdate<Entity>`) already send
   whatever object they're given; typing them against `<Entity>Patch` (and threading the version
   field through forms, ActiveRecord-hidden-field style) is a client-ergonomics follow-up, out of
   scope here.
9. **Small latent TS bug found en route (fixed by Phase 4, worth naming):** the queries-tier
   `InsertSchema.partial()` silently replaces a caller-supplied `@autoSet onCreate` value with
   `now()` on update (verified against Zod 4.4.3 behavior — supplied keys run the transform;
   absent keys are dropped). The routes tier is unaffected (it uses `UpdateSchema`).
