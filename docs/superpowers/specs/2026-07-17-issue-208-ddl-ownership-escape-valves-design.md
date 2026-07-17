# FR #208 — DDL-ownership escape valves (`@sql` body + `@unmanaged` marker)

_Design doc. Status: approved (owner accepted D1–D7 on 2026-07-17). Designed with Fable per the #195 owner ruling (2026-07-15)._

## 1. Problem, and the framing correction

The #195 design (§8) chartered a separate FR for the "this DB object is not tool-synthesized" escape valve: an **`@sqlView`-style attribute carrying a hand-written view body**, plus a distinct **"managed elsewhere"** marker, generalizing to **any** DB object (entities included). #208 is that FR.

The issue frames the motivation as "one irreducible view aborts the entire `meta migrate` run." That framing is now **mostly stale**: `build-projection-views.ts` (~lines 90–121) already `continue`-skips the un-synthesizable read-only kinds — `storedProc`/`tableFunction` (callables), `materializedView` (hand-managed), and a standalone origin-free read-model — and `viewIsDerived()` codified the classification. The remaining throw in `extract-view-spec.ts` (`baseEntityFor`, ~lines 333–337) fires only for genuinely malformed shapes (an `origin.*` with no resolvable anchor) and should **stay** — that is a real authoring error, not an escape-valve case.

So #208 delivers the two things skipping **cannot**:

1. **Visibility.** A skipped hand-written view is *invisible* to the tool — `meta migrate` neither owns nor emits it, and `meta verify --db` cannot drift-check it. It degrades to "accidentally unmanaged."
2. **The load-bearing hole — silent wrong synthesis.** An escape-valve view *cannot declare its lineage* today. The moment it carries an `extends`-bound `identity.primary` (row identity for the read model) or `extends`-bound fields, `viewIsDerived()` flips **true** and the tool **synthesizes a wrong body** — a trivial base-table passthrough `SELECT` — instead of the author's intended irreducible SQL. That silent-wrong-synthesis is worse than an abort. Closing it requires classifying **DDL-ownership before** `viewIsDerived` (the **suppression rule**, §6) — the one non-deferrable, bug-shaped piece of this FR.

## 2. Decision summary (locked)

| # | Decision | Choice |
|---|---|---|
| D1 | Hand-written-body attribute name | **`@sql`** (on `source.rdb`) |
| D2 | Managed-elsewhere marker name | **`@unmanaged: true`** (on `source.rdb`) |
| D3 | `origin.*` under an `@unmanaged` host | **WARN** (load-time) |
| D4 | v1 `@sql` migrate lowering scope | **plain `@kind: view` only** (matview/proc/tableFunction hard-error) |
| D5 | `@filter` (#207) + `@sql` on one projection | **reject** (no outer-WHERE wrapping) |
| D6 | Materialized-view default | **implicitly hand-managed**; `@unmanaged` optional-declarative (non-breaking) |
| D7 | `@sql` view dependency tracking | **derive `dependsOn` from `extends`-bound anchors only** (no new `@dependsOn` attr) |

## 3. Vocabulary (ADR-0037 applied)

Both markers are **attributes on `source.rdb`**, contributed by the **db domain provider** (canonical `spec/metamodel/db.json` → regenerated `db-definition.embedded.ts`). Neither is object-level: an entity opts out by declaring its *source child* with the marker (`{ "source.rdb": { "@unmanaged": true } }`), where ADR-0007 says physical-storage concerns live. Per-source granularity is strictly more expressive — a write-through entity can keep its table managed while marking only its read-view source unmanaged — and avoids an "object says X, source says Y" conflict.

### 3a. `@sql` — the hand-written body

ADR-0037 ordered test: **Step 0** (derivable?) no — it exists *because* `origin.*` cannot express the body. **Step 1** (physical-only?) **yes, decisive** — the body changes no native type and no logical meaning; the projection's declared fields still type the read model and the wire contract is untouched. It is a pure physical-DDL payload, the same category as the existing db-provider raw-SQL escapes `@where`/`@expr` (`db-definition.embedded.ts` ~211–233). We never reach step 2 — not a subtype (no distinct native type / behavior / child vocabulary — still an RDB view; a `source.sql` subtype would fork the whole `@kind` axis), not a `@kind` (a hand-bodied view is still `@kind: view`; DDL-provenance is a *second* axis, and folding it into `@kind` makes `@kind` the ADR-0037-forbidden catch-all).

**Name `@sql`** (not `@sqlView`: view-specific, self-contradictory on a matview, fails the any-object mandate; not `@ddl`: implies the full `CREATE … name … AS` statement, duplicating the kind-matched physical-name attr `@view`/`@materializedView` — two sources of truth for the name; not `@body`: needs a "body of what?" lookup). `@sql` self-documents on `source.rdb` (the RDB paradigm subtype), and generalizes **by pattern, not literal name** — a future non-RDB paradigm subtype registers its own body attr (a `source.doc` would carry `@pipeline`), exactly as `@table`/`@schema` are RDB-only today.

**Semantics pinned:** `@sql` carries the body that goes **inside** `CREATE <kind> <physicalName> AS …` — never the `CREATE` wrapper, never the object name (the fingerprint machinery already strips any `CREATE VIEW … AS` wrapper before hashing: `view-fingerprint.ts` `normalizeForFingerprint` ~45–67, confirming the *body* is the canonical unit). Authored in YAML as a sigil-free block scalar (`sql: |`), per ADR-0006. A non-empty string is required.

### 3b. `@unmanaged: true` — the managed-elsewhere marker

ADR-0037: not derivable, not column-physical — it is tool-lifecycle configuration → attribute (step 2c). A **boolean exception-flag** (the common case is absent): `@unmanaged: true`. Rejected `@managed: false` — ADR-0037 2c forbids a default-true opt-out. Rejected an enum (`@lifecycle: managed|supplied|external`) — the "supplied" state is already carried by `@sql`'s *presence* (redundant, disagreement-prone state), and "managed" is the never-authored default (a one-value-in-practice enum = a boolean in costume).

**Name `@unmanaged`** pins the *contract* — not created, not dropped, not drift-checked — in the tool's own established drift vocabulary (`drift/classify.ts` already calls exactly-this-treatment "unmanaged"). The marker makes an object **declared-unmanaged** rather than accidentally-unmanaged. (Runner-up `@external` names the reason not the contract, with a slight `@role`-external-system collision.)

### 3c. Orthogonality — one axis, two attrs

The two markers are the two non-default states of **one axis — who owns this object's DDL**: `derived` (default; tool synthesizes from `origin.*`/`extends`) · `supplied` (`@sql`; author writes the body, tool manages the lifecycle) · `external` (`@unmanaged`; someone else manages the DDL). They are **mutually exclusive** on a single source ("emit + fingerprint this" contradicts "never touch this"). But the *two-attribute* spelling is correct because the supplied state carries a payload and the external state is a bare flag — collapsing them into one enum re-introduces redundant state. **Conceptually one axis, syntactically two attrs, mutual exclusion enforced by the loader.**

## 4. Cross-port scope (mirrors #207)

**All five ports:** the two attrs registered in `spec/metamodel/db.json` + `SOURCE_ATTR_SQL` / `SOURCE_ATTR_UNMANAGED` constants + resolving accessors on each port's `MetaSource` (follow the `@role`/`effectiveKind` *resolving* precedent — sources are inheritable — **not** the `@dbColumnType` own-only exception); `fixtures/registry-conformance/expected-registry.json` + a `source-sql-escape` registry fixture; the §5 loader validation rules + conformance error-fixtures under `fixtures/conformance/`; canonical-serializer passthrough (free). **Gotcha:** C# and Python carry a *committed* `SpecMetamodel/db.json` copy that must be synced (Java auto-refreshes from the repo-root spec) — forgetting one silently reds that port's registry-conformance.

**TS-only (ADR-0015 — schema is TS-owned):** everything in §7 (migrate) and §8 (verify) — `build-projection-views.ts`, `expected-schema.ts`, the diff threading, the CLI, `verify`. **No per-port codegen change** — read-model/DTO generation already keys off declared fields + the physical view name; neither marker changes the read surface.

## 5. Loader validation (cross-port) — fail-closed rules + error codes

Metamodel semantics run in all five loaders (validation cross-port, lowering TS-only, mirroring #207). New per-port pass `validate-source-escapes.ts` (sibling of `validate-source-roles.ts`). Proposed codes follow the existing granular convention (`ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND`):

1. **`@sql` AND `@unmanaged` on the same source → `ERR_SQL_BODY_WITH_UNMANAGED`.** Contradictory DDL owners (§3c).
2. **`@sql` on a writable kind (`@kind: table`) → `ERR_SQL_BODY_ON_WRITABLE_KIND`.** A hand-written `CREATE TABLE` would bypass the column-diff machinery that is the tool's core; tables are fully modeled or `@unmanaged`, never opaque-bodied.
3. **`origin.*` children under a host whose read source carries `@sql` → `ERR_ORIGIN_UNDER_SQL_BODY`.** Two bodies (one synthesized-from, one verbatim) = two sources of truth; fail closed.
4. **`@filter` (#207, on `object.projection`) + `@sql` → reject** (`ERR_ORIGIN_UNDER_SQL_BODY` family, or reuse `ERR_BAD_ATTR_FILTER`). The #207 filter lowers to the outer `WHERE` of a *synthesized* body; with `@sql` the author owns the `WHERE` (D5 — outer-WHERE wrapping is deferred cleverness).
5. **`@sql` empty / non-string → `ERR_BAD_ATTR_VALUE`.**
6. **`origin.*` under an `@unmanaged` host → WARN (not error)** (D3). Preserves today's matview symmetry (matviews legally carry origins with no marker) and lets an author document lineage for future in-process evaluation (#211). (Contrast rule 3: `@sql` is a hard error — a verbatim body plus a derivation is genuinely two sources of truth; `@unmanaged` acts on *nothing*, so a documented-but-unacted-on lineage is benign.)

**Legal by construction (no rule needed):** `@sql` on a projection's primary read-only source (an entity-primary read-only source is already blocked by `ERR_ENTITY_PRIMARY_SOURCE_READONLY`, and rule 2 covers table-kind); `@unmanaged` on any kind **including `table`** (that IS the Flyway-owned-entity case — the "generalizes to entities" half, delivered for free); `@unmanaged` on a write-through entity's non-primary view source (table managed, view skipped).

## 6. The suppression rule (load-bearing; TS classification)

An `@sql`- or `@unmanaged`-marked read source **suppresses derivation-classification entirely**: the branch runs **before** `viewIsDerived` (`build-projection-views.ts` ~line 121) and before `extractViewSpec` is ever called. This is what lets an escape-valve host legally carry `extends`-bound fields and a borrowed `identity.primary { extends: "Base.id" }` as pure shape / row-identity declarations *without* the tool mis-synthesizing a body (the §1.2 hole). ADR-0028's "self-declared under external assembly" already licenses these declarations — **no ADR-0028 change needed**. This lives in the TS classification code (the loaders' job is only rules §5.1–§5.6).

## 7. Migrate mechanics (TS-only, ADR-0015)

The elegant property: **an author-supplied body enters the exact pipeline the synthesized body already rides** — almost no new machinery.

**`@sql` branch** — in the projection classification loop (`build-projection-views.ts` ~117–122) and the write-through host loop (~134–140), *before* `viewIsDerived`: if the read-only source carries `@sql`, push an `ExpectedView` directly — `name` = `physicalName` (FR-016 four-step), `schema` = `resolveTableSchema`, `sql` = the verbatim attr, `dependsOn` = tables of the host's `extends`-bound anchor entities (D7), `columns` = **omitted**. Everything downstream is existing machinery:
- `buildExpectedSchema` Pass 4 computes the fingerprint from `v.sql` — unchanged.
- Emit stamps the COMMENT marker (`emit/postgres.ts` ~290–313) — unchanged; author re-indentation does not re-stamp (whitespace collapse).
- Absent `columns` already means "unknown" → the diff **fails safe to gated drop+create** instead of a wrong-but-confident `CREATE OR REPLACE`.
- **Adopting a pre-existing hand-written view:** first diff sees expected-fingerprint vs an unstamped DB view → `replace-view` with `unmanagedActual`, **blocked pending `allow.adoptView`**. `meta migrate --allow adopt-view` stamps it once; thereafter it converges. **Document this flow prominently** — it is the one-time adoption ceremony.
- **Drop / down-migration:** removal from the model → `drop-view` gated by `allow.dropView` + CASCADE annotation; `restore` = the introspected body (deparsed on PG, verbatim on SQLite) — all existing.

**`@unmanaged` branch** — skip sites + act-side silencing:
- Views: skip in both `build-projection-views.ts` loops (never enters `expected`).
- Tables: skip in `buildExpectedSchema` Pass 1 (drops its columns/indexes/FKs/checks from the expected side). **Caveat:** an FK *from a managed table into* an unmanaged table must still resolve the target's physical name for its DDL — keep the unmanaged entity in `entityToTable` even though it emits no `TableDescriptor` (an FK into a Flyway-owned table is legal; migration *ordering* vs the external tool is a documented adopter caveat, not an error).
- **Act-side silencing:** introspection returns *all* views/tables in declared schemas, so a declared-unmanaged object would otherwise surface as a `drop-*` proposal. Thread a set of declared-unmanaged qualified names from the CLI (`cli/commands/migrate.ts`, `verify.ts`) into the diff so those are **skipped** — a declared-external object produces *silence*, not a policy-gated drop.

**Matview (D4/D6):** matviews stay implicitly hand-managed (status quo); `@unmanaged` on one is legal-and-redundant (now *declared*). `@sql` on `@kind: materializedView` is the future managed path but needs genuinely new introspection (`pg_matviews` — matviews are invisible to `information_schema.views` — plus COMMENT-on-matview plumbing and a REFRESH story). **v1:** `@sql` is legal-in-vocabulary on any read-only kind (5-port registration is stable), but the **TS migrate lowering accepts it only on `@kind: view`** and hard-errors with an actionable message on matview/proc/tableFunction ("not yet migrate-managed; mark `@unmanaged` or track a follow-up") — same tiering as SQLite's `@schema` rejection.

## 8. `verify --db` mechanics (TS-only)

- **`@sql`** → drift-checked *identically to synthesized views*, for free: expected fingerprint vs the COMMENT stamp on PG, verbatim body compare on SQLite/D1. An unstamped view at a modeled `@sql` name reports `replace-view unmanagedActual` drift — correct ("run `migrate --allow adopt-view`"). Managed-but-opaque, exactly as chartered.
- **`@unmanaged`** → absent from `expected`; the DB object already classifies as informational-unmanaged (`drift/classify.ts`). With the threaded name-set, annotate it "external (declared)" vs "unmanaged (unmodeled)" — a small UX win that makes the declaration visible.
- **Known edges (document, don't fix):** whitespace collapse inside string literals can mask intra-literal drift (pre-existing, shared with synthesized bodies); SQLite `normalizeViewSql` lowercasing likewise. A v1.5 note: PG exposes an `@sql` view's output columns via `information_schema.columns`, so verify *could* column-name-check an opaque body against the declared field set — deferred, but it is the eventual answer to "the hand body must alias its columns to match the read model."

## 9. Docs & ADR

- New **ADR-0043 — "DDL-ownership escape valves"** (durable cross-language vocabulary contract: the one-axis / two-attr model, the ADR-0037 attribute rationale, the suppression rule, the TS-only lowering split).
- Rewrite `agent-context/skills/metaobjects-verify/references/migration.md` (currently states "There is no attribute that injects hand-written SQL into a projection view body (by design)") and the `downstream-metadata-decisions.md` hand-write exception to point at `@sql`/`@unmanaged` and the adoption ceremony.

## 10. Recommended build order

1. **TS reference first (end-to-end):** register `@sql`/`@unmanaged` in TS (`db.json` + constants + `MetaSource` accessors) → the §5 loader validation + the §6 suppression rule → the §7 migrate branches (`@sql` emit-verbatim + fingerprint; `@unmanaged` skip + silencing) + a golden-DDL fixture and a real-Postgres round-trip in `view-lifecycle-pg.test.ts` (an `@sql` view: emit → fingerprint → second migrate is a NO-OP → adopt an unstamped pre-existing view under `--allow adopt-view`; an `@unmanaged` object: migrate is silent, verify reports "external (declared)"). **Checkpoint.**
2. **Fan the registration + validation out to the other 4 ports** (report-only agents; sync the committed C#/Python SpecMetamodel copies) + the `registry-conformance` fixture + the conformance error-fixtures + a cross-port divergence review.
3. **ADR-0043** + the docs rewrites.

## 11. YAGNI cuts (deferred, not in v1)

`@sql` bodies for storedProc/tableFunction (full-statement bodies + `pg_get_functiondef`/signature-qualified COMMENT machinery; already cleanly skipped, and `@unmanaged` covers them); per-dialect `@sql` bodies (a project targets one `config.dialect`); an `@dependsOn` physical-table-list attr (D7 — defer until an adopter hits an undeclared-dependency alter); the matview managed path (D4); column-name verification of opaque bodies (v1.5); outer-WHERE wrapping of `@sql` + `@filter` (D5).

## 12. Open questions

None blocking. The matview managed path (`@sql` on `@kind: materializedView`) and column-name verification of opaque bodies are the two deferred follow-ups worth filing once Group A lands.
