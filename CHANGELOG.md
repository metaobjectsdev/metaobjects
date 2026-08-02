# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0; MINOR bumps may introduce breaking changes with notice).

## [0.20.10] — 2026-08-02

**Coordinated PATCH** — npm `0.20.10` · PyPI `0.19.9` · NuGet `0.19.7` · Maven Central `7.11.7`.
This cut bundles the cross-port **#228** (all 5 ports — the reason for the coordinated release)
with two **npm-only** fixes, **#248** and **#255** (`migrate-ts` + `codegen-ts`; schema/DDL is
TS-owned, ADR-0015, so no other port has the changed code). Existing `meta gen` / `meta migrate`
output is byte-identical for every model without a cross-package short-name collision (#228),
without a sourceless object (#248), and without a drop-before-column migration (#255).

### Fixed — extract/output-parser tier and build-time `@payloadRef`/`@responseRef` resolution under a cross-package payload collision (#228)

ADR-0044 (#219/#220) gave every port's *payload-record* emitter collision-scoped naming: two
cross-package `object.value`s sharing a bare short name (`acme::alpha::Note` /
`acme::beta::Note`) now each emit a distinct, package-qualified type instead of silently
colliding. The **extract tier** — the `template.output`/`template.toolcall` parser generator
that reads a rendered payload back off an LLM response — was a sibling generator ADR-0044
flagged as a recurrence risk but did not fix: it named and imported nested value-object
classes by bare short name, so under a real collision it referenced a class the payload
generator no longer emits. This half is **latent** — the only shipped collision fixture
(`fixtures/template-output-render-conformance/xpkg-collision/`) used `@format: html`, which the
extract tier never runs against (it only engages for `@format: json | xml`) — closed by a new
`xpkg-collision-json` fixture plus a hardcoded per-port collision test, all five ports.

A second, **reachable** bug surfaced auditing the fix: several build-time
`@payloadRef`/`@responseRef` resolvers — feeding the extract tier, the render-helper /
output-prompt generators, and (JVM ports) the `meta:verify` template-drift check — resolved a
bare ref package-blind (first-match by load order, or a bare-tail fallback), while the loader
validates the same ref package-local per ADR-0042. Under a genuine cross-package bare
collision this meant the loader accepted object A while codegen silently emitted against
object B. Fixed by routing every one of these resolvers through each port's canonical
package-local resolver, threading the referring template's package: Python
(`resolve_payload_vo` + `render_helper_generator` + `@responseRef`), C# (`VerifyCommand` /
`BuildPayloadFieldTree`), Java (five call sites consolidated into a new `SpringNaming` helper,
plus a `LlmTraceHelperGenerator` bare-tail fix), Kotlin (`KotlinGenUtil` — reusing the loader's
own `SymbolTable` — plus the render-helper, output-prompt, and api-docs generators, and the
shared `codegen-base/TemplateVerify.java` used by both JVM ports).

A third fix closes a **generated-runtime** analog: TS, Python, and C#'s generated
output-parser code resolved its *own* `@payloadRef` payload by a bare runtime lookup — wrong
under a cross-package bare collision between two `template.output`s (or a payload bare-name
colliding with another root object). All three now bake the fully-qualified name and resolve
package-locally only when the bare name is genuinely ambiguous; byte-identical when it isn't.
Java and Kotlin already baked the FQN in generated code and needed no change here.

TS additionally extended its entity-tier collision-scoped naming (previously payload-record
only) to cover every value-object *reference* site reachable from an entity module —
write-through read-views, projection declarations, and view declarations — plus a `runner.ts`
load-order package-binding misbind found in the same pass (the same class of bug #244 fixed
elsewhere), and fixed a reachable **runtime** wrong-data bug in `runtime-ts`'s
`extract-object.ts` (a bare-tail fallback resolver that extracted a nested colliding
value-object using the wrong package's shape).

Byte-identical for every non-colliding model, all ports. Gated by the new
`xpkg-collision-json` fixture plus a per-port collision test (compile-and-run proof where the
port's toolchain supports it). Reuses `ERR_PAYLOAD_NAME_COLLISION` — no new error code, no new
metamodel vocabulary (ADR-0023 unaffected). See
[ADR-0044](spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md), whose
Consequences section now marks this recurrence closed.

### Fixed — persistability derives from a declared/inherited source, never object subtype (#248)

**npm-only** (`migrate-ts` + `codegen-ts`; PyPI / NuGet / Maven Central unchanged — schema
migrations and this codegen tier are TS-owned artifacts, ADR-0015, and no other port emits
DDL). Both `migrate-ts`'s expected-schema builder and `codegen-ts`'s query/route/api-doc
emitters decided "is this object persisted?" against a hardcoded `subType === "value"`
compare (migrate) or a subtype allowlist (codegen), instead of asking whether the object
declares — or inherits via `extends` — a `source.*` child, which is the loader's own
already-published contract (`validate-source-roles`: an object with zero sources loads clean
and means "not persisted"). Any OTHER provider-registered `object` subtype with no source fell
through both gates and was silently treated as persisted.

- **`meta migrate` / `meta verify --db|--d1`:** a sourceless object no longer produces a
  phantom `CREATE TABLE` (with a fabricated physical table name) and is no longer eligible as
  a foreign-key target. Reported blast radius: a package of roughly 150 wire-protocol message
  objects modeled as a registered custom `object` subtype, co-loaded with domain entities so
  messages could reference them, produced well over a hundred phantom `CREATE TABLE`
  statements — making `meta migrate` and `meta verify --db` unusable against that model.
- **`meta gen`:** queries/routes (both the Fastify and Hono generators) and api-doc CRUD are
  no longer emitted for a sourceless object, gated on the presence of a `source.rdb` of any
  kind (a new `hasAnyRdbSource` check) — matching the Drizzle table tier's existing
  `hasWritableRdbSource` gate. This also closes a pre-existing fail-open where a plain
  `object.value` got a broken `*.routes.ts` file, importing a table const and
  filter/sort allowlists that don't exist for a value object.

This is a bugfix, not a behavior-contract change — it aligns both tiers to an invariant the
loader already enforces. `meta gen` / `meta migrate` output is **byte-identical** for
well-formed models (every table-owning object declares or inherits a source, the norm); the
only delta is that files which could never have typechecked (importing exports that don't
exist) stop being emitted.

**Migration note for models already bitten by the bug:** a database or migration snapshot
that already contains phantom tables (created by applying a pre-fix migration) will correctly
propose `DROP TABLE` for them on the next `meta migrate` — destructive-gated behind the
existing `--allow drop-table` policy, so nothing drops without explicit opt-in.
Previously-generated broken `*.queries.ts` / `*.routes.ts` files are **not** auto-pruned
(`meta gen` never deletes existing files) — remove them by hand.

### Fixed — migrate emits constraint/index DROPs before DROP COLUMN so referenced-column drops apply (#255)

**npm-only** (`migrate-ts`; PyPI / NuGet / Maven Central unchanged — schema migrations are
TS-owned, ADR-0015). The SQL emitter's stage ordering ran `DROP COLUMN` before `DROP CONSTRAINT`
(foreign key / check) and `DROP INDEX`, so dropping a column that a still-present foreign key
referenced — or that a still-present index backed — produced an **un-appliable** migration
(`cannot drop column … because other objects depend on it`). Both the Postgres and SQLite
emitters now hoist every constraint/index drop ahead of column mutation: `drop-fk`/`drop-check`
first, then `drop-index` (a foreign key depends on the unique/PK index backing its target, so the
FK must be dropped before that index), then the column ops; the matching adds
(`add-fk`/`add-check`/`add-index`) stay after column mutation (they reference columns that must
already exist). Reproduced against a real Postgres before fixing (emit → apply → introspect →
re-diff-empty), including the combined FK + backing-index + column-drop case.

Byte-identical for any migration that contains none of `drop-fk` / `drop-check` / `drop-index`. A
migration that combines one of those drops with a column change now emits the same statements in
the corrected order — **re-review any committed-but-not-yet-applied migration file** that drops a
foreign key / check / index alongside a column, since its statement order changes (and will now
apply where it previously failed).

## [0.20.9] — 2026-07-28

**npm-only** — `migrate-ts` + `codegen-ts` (schema migrations and projection-view codegen
are TS-owned, ADR-0015); PyPI / NuGet / Maven Central are unchanged.

### Fixed — a projection/view over a rebuilt table is no longer stranded mid-migration (#243)

On SQLite and Cloudflare D1, a table is rebuilt via recreate-and-copy (DROP + RENAME) not
only for column changes but also for CHECK / foreign-key / evolved `field.enum @values`
changes — and, on D1, for any table pulled into the FK-cascade as a referrer. A view
reading that table was left dangling across the rebuild, so the migration failed at apply
time (`error in view …: no such table …`). The diff now drops a dependent view **before**
the rebuild and recreates it **after** for the CHECK/FK/enum-values class too (previously
only column-altering changes triggered it), and the D1 cascade drops/recreates every view
over an affected table in the correct order — no double-emit. Postgres is unaffected
(FK/CHECK changes there are `ALTER … ADD/DROP CONSTRAINT`, no table rebuild).

### Fixed — cross-package references bind by fully-qualified name; duplicate generated SQL names are refused (#244)

When two packages declared a same-bare-named `object.entity`, a fully-qualified
`@references` / projection `origin.passthrough @from` / `@via` did **not** reliably bind the
qualified target — the package qualifier was discarded and the bare name resolved against a
global slot, so which entity won depended on metadata **file load order**. This produced a
silent wrong-table foreign key (the serious case: no error, an FK against the wrong table)
and/or an invalid projection view whose `SELECT`/`JOIN` read the wrong package's table
(`column … does not exist` at apply). Both the schema builder (`migrate-ts`, FK targets) and
the projection view-spec (`codegen-ts`, `@from`/`@via`/`@of`/`extends` join resolution) now
resolve object references package-aware via the loader's `resolveObjectRef` /
`resolutionKey()` contract — an FQN binds exactly, a bare ref binds the referrer's own
package then a root-level object, and an ambiguous bare name resolves to nothing rather than
guessing. Generated view SQL (aliases, column order) is byte-identical for existing
single-package models. Separately, two distinct metadata objects that generate the **same**
database name (schema-qualified — table/table, view/view, or table/view, across packages)
now fail at build time with `ERR_DUPLICATE_SQL_NAME` naming both owners, instead of emitting
an un-appliable migration the database would reject.

## [0.20.8] — 2026-07-28

**npm-only** — the changed code is all in `migrate-ts` (D1 is a TS-only dialect);
PyPI / NuGet / Maven Central are unchanged.

### Added — D1 auto-cascade for rebuilding foreign-key-referenced tables (#241)

npm-only (`migrate-ts` — D1 is a TS-only dialect). `meta migrate --dialect d1` no
longer refuses when a change would rebuild a table that another table's foreign key
references ([#226](https://github.com/metaobjectsdev/metaobjects/issues/226)) — it now
**auto-generates an appliable cascade** instead. The emitter rebuilds the referenced
table together with every table that transitively references it, in one pass: the
affected tables are dropped referrers-first and recreated parents-first, under `PRAGMA
defer_foreign_keys = ON` so every foreign-key check defers to the end of D1's implicit
transaction rather than firing mid-rebuild. The cascade is built over the **union of
the actual (live) and expected (target) schemas' foreign-key graphs**, closing #226's
residual under-refuse gap: a single migration that both rebuilds a referenced table
*and* drops the referencing foreign key in the same run is now detected and handled
correctly (a target-schema-only check missed this). A **multi-table foreign-key cycle**
(two or more tables referencing each other in a loop) has no parents-first rebuild
order and is still refused at generation time with actionable guidance; a
self-referencing table is not a cycle and is rebuilt by the cascade like any other
table. Migrations that do not rebuild a foreign-key-referenced table are
**byte-identical**. Gated by a real-libSQL-engine convergence round-trip across every
cascade topology (linear chain, diamond, self-reference), the #226 gap scenario, and
the cycle-refusal case.

## [0.20.7] — 2026-07-28

**npm-only** — the changed code is all in `cli` / `migrate-ts`; PyPI / NuGet / Maven
Central are unchanged (different ports on different version lines). Bundles a D1 migrate
bug fix (#226) and an additive `meta migrate apply-pending` CLI subcommand (#242).
Existing `meta gen` / `meta migrate` output is unchanged for migrations that don't
rebuild an FK-referenced table on D1.

### Fixed — `meta migrate --dialect d1` no longer emits an un-appliable rebuild of a foreign-key-referenced table (#226)

npm-only (`migrate-ts` — D1 is a TS-only dialect). On remote Cloudflare D1 a migration
runs inside D1's implicit transaction, where `PRAGMA foreign_keys = OFF` is a no-op — so
the SQLite table-rebuild recipe failed to drop a foreign-key-referenced table, aborting
the migration with `FOREIGN KEY constraint failed`. The failure was silent until a table
held rows, so it first surfaced against populated production databases. `meta migrate
--dialect d1` now **refuses at generation time** with a clear, actionable error when a
change would rebuild a table that another table's foreign key references (self-references
included), instead of emitting SQL that fails at apply time. Migrations that do not
rebuild a referenced table are byte-identical. Auto-generating the rebuild cascade is
tracked as a follow-up (#241).

### Added — `meta migrate apply-pending` (#242)

npm-only (`@metaobjectsdev/cli`). A first-class subcommand that replays the committed
migration files against `--db` (ledger-tracked, transactional) with no diff and no
metadata load — the fresh-DB / CI provisioning path the diff-first `meta migrate
--apply` cannot serve (on an empty DB `--apply` exits before `applyPending` runs, or
authors a redundant migration). A thin wrapper over the already-public `applyPending`;
idempotent, `--dry-run` lists pending. postgres/sqlite only (D1 uses `wrangler d1
migrations apply`).

## [0.20.6] — 2026-07-26

**Coordinated PATCH** — npm `0.20.6` · PyPI `0.19.8` · Maven Central `7.11.6` · NuGet
`0.19.6`. #234 is a cross-port fix, so all four registries release together. Existing
`meta gen` output is byte-identical when `@lenient` is absent.

### Added — `@lenient` opt-out on `field.uri` / `field.inet`; strict well-formedness pinned cross-port (#234)

Two halves, one release:

- **Strict accept/reject is now pinned and identical across all five ports** (on the shared
  `validation-conformance` probe set, which spans the URI/IP-literal edge cases — scheme-less,
  relative, garbage, empty-authority, leading-zero octet, IPv4-mapped IPv6, CIDR, padding).
  A `field.uri` must be an
  **absolute, scheme-bearing URI** (`https://a.com`, `mailto:a@b`, `urn:…`; a scheme-less
  `example.com` or a bare `/path` is rejected) and a `field.inet` must be an **IPv4/IPv6 literal**
  (no hostnames, no CIDR, no padding). Previously the ports diverged: C#/Java/Kotlin accepted
  relative URIs, and the JVM ports resolved **hostnames into `field.inet` via a live DNS lookup on
  the request path** (blocking I/O, a network-dependent verdict, and a silent value rewrite) — now
  fixed. Enforcement lives at each port's wire/bind layer via small generated, dependency-free
  support files (`MetaNetBindings.java` / `MetaNetJson.kt` / `MetaNetValidation.cs`; TS keeps its
  Zod check, Python its Pydantic type). **This is a wire-acceptance change for existing C#/Java/Kotlin
  deployments** that were accepting values now rejected — the escape hatch ships in the same release:
- **`@lenient: true`** (a new optional boolean attribute on `field.uri` / `field.inet`, registered
  cross-port + gated by `registry-conformance`) opts a field **out** of strict enforcement: codegen
  binds a plain string (no URL/IP validator, no native `URI`/`InetAddress` type) so a
  not-necessarily-well-formed value — an LLM-emitted citation URL, a user-supplied host — round-trips
  unchanged. A `field.inet @lenient` additionally uses a plain `text` column instead of the native
  `inet` type, so **toggling `@lenient` on an existing `field.inet` is schema-affecting** (an `ALTER`
  on the next `meta migrate`). Strict remains the default (attr absent/false → byte-identical output).

Gated by the shared `validation-conformance` corpus (strict accept/reject + `@lenient` accept-garbage,
identical boolean verdicts on all five ports) and a real-Postgres idempotence + value-semantics
round-trip for the lenient-inet `text` column. Also fixes a **latent Zod-4 bug**: `field.inet` codegen
emitted `z.string().ip()`, which was removed in Zod 4 (the workspace + generated consumers run Zod 4);
it now emits a version-agnostic IPv4/IPv6 regex union valid on both Zod 3 and Zod 4.

## [0.20.5] — 2026-07-26

**Coordinated release** — npm `0.20.5` · PyPI `0.19.7` · Maven Central `7.11.5` · NuGet
`0.19.5`. **#236 (abstract required-attr exemption) and #237 (`@maxTokens` on
`template.toolcall`) are cross-port**, so PyPI / Maven / NuGet each release the loader +
metamodel change too; **#235 and #240 are npm-only** (`migrate-ts` — schema migrations are
TS-owned, ADR-0015, so no other port has a migrate engine to fix). All changes are additive
(PATCH): existing `meta gen` output is byte-identical, and #237 adds a single optional
registry attr (gated by `registry-conformance` in all five ports).

### Added — `@maxTokens` on core `template.toolcall` (#237)

**Cross-port** (metamodel — TS / Java / Python / C# / Kotlin). `@maxTokens` (a vendor-agnostic
per-call token budget, already core on `template.prompt`) is now registered on
`template.toolcall` too, so a tool-call's response token budget is first-class metadata rather
than an `attr.properties`-bag / hardcoded runtime concern. Per the ADR-0037 decision procedure
it's a §2c configuration attribute (`int`, optional). **`@fallback` is deliberately NOT
promoted** — ADR-0011 charters retry/fallback shapes as consumer-provider (vendor-specific)
extensions, and `@fallback`'s value is a vendor-specific structured object; it stays a
`registry.extend` concern. Registered in all five ports + gated by `expected-registry.json`
and the `template-toolcall-maxtokens` conformance fixture.

### Fixed — an abstract `template.prompt` may omit a required `@payloadRef` (#236)

**Cross-port** (loader — TS / Java / Python / C#; Kotlin inherits the JVM loader). The generic
required-attr check flagged an **abstract** node for a missing required attr, so an abstract
`template.prompt` that hoists shared children but leaves `@payloadRef` to its concrete subtypes
(or to `extends`) failed to load — forcing every concrete prompt to restate it. An abstract is
a template, not an instantiated node, so it's now **exempt** from the required-attr check;
enforcement stays at the concrete level (a concrete node's resolving attr set must still satisfy
the requirement — a concrete missing `@payloadRef`, inherited or own, still errors
`ERR_MISSING_REQUIRED_ATTR`). Consistent with ADR-0039 (all four ports already read the
resolving set for this check; the fix is the abstract exemption). Gated by the
`abstract-template-prompt-hoists-payloadref` conformance fixture across all four ports.

### Fixed — empty-string column `@default: ""` no longer drifts on sqlite/d1 (#235)

**npm-only** (`migrate-ts`). `buildExpectedSchema` dropped an empty-string default with a
falsy `defaultRaw.length > 0` guard, so a `field.string @default: ""` column read as
"no default" — perpetually drifting against a DB that has `DEFAULT ''` (a destructive
recreate-and-copy on every sqlite/d1 migrate) and disagreeing with codegen (Drizzle emits
`.default("")`). Only `undefined` now means "no default"; `""` is kept as a literal. Gated by
the real-SQLite default-semantics round-trip (emit `DEFAULT ''` → apply → introspect → re-diff
empty; a seeded row stores the empty string, not NULL). Introspection already round-tripped
`DEFAULT ''`; the fix was purely the expected-side falsy check.

### Fixed — offline `--allow adopt-view` illegal `CREATE OR REPLACE` for a projection (#240)

**npm-only** (`migrate-ts`). Follow-up to #239: the 0.20.4 fix keyed the legal/illegal
`CREATE OR REPLACE` decision on **both** column sets being known, but the OFFLINE
(snapshot-based) migrate path — the primary authoring path — diffs against a pre-fingerprint
snapshot that records **no view columns**, so `actual.columns` is undefined and the adopt
branch fell back to a non-destructive `replace-view` (= illegal `CREATE OR REPLACE`) even for
a projection whose desired shape is fully known. The decision now keys on the **expected**
(desired) view's columns only: a known projection runs `viewReplaceIsLegal` (which fail-safes
to drop+create when the actual columns are unknown), so a structural change drop+creates
offline too; an opaque `@sql` body (expected columns unknown) still keeps its non-destructive
replace on adoption. Gated by a diff unit test (expected-known / actual-columns-absent →
drop+create, still gated on `adoptView`); #208 `@sql` adopt + #239 real-PG round-trip unchanged.

## [0.20.4] — 2026-07-26

**npm-only** (NuGet `0.19.4` / PyPI `0.19.6` / Maven Central `7.11.4` unchanged — schema
migrations are TS-owned, ADR-0015, so no other port has a migrate engine to fix).

### Fixed — `--allow adopt-view` no longer emits an illegal `CREATE OR REPLACE VIEW` (#239)

`migrate-ts` + `cli`. `meta migrate --allow adopt-view` emitted `CREATE OR REPLACE
VIEW` when adopting an **unmanaged** Postgres view (one with no MetaObjects fingerprint —
created before view stamping, or hand-written) that was **also** structurally changed in the
same migration (column rename / reorder / mid-list insert). Postgres rejects that DDL at apply
time (`cannot change name of view column …`), aborting the migration on any DB that already
holds the prior view. It was invisible until apply: offline `meta migrate` and a freshly
provisioned DB (where `CREATE OR REPLACE` behaves as a plain `CREATE`) never hit it — it bites
exactly once per project, on the first migration authored after upgrading into view
fingerprinting.

The adopt-view branch now runs the **same** legal/illegal `CREATE OR REPLACE` decision the
managed path already made (`viewReplaceIsLegal`): a legal append stays a non-destructive
`replace-view`; a structural change is emitted as `drop-view` + `create-view` (the recreated
view is re-stamped, so the next migrate converges). Adopting an unmanaged view still requires
`allow.adoptView` in both cases — the drop+create path carries the adopt-view gate so the
recreate-pair auto-allow can't silently clobber hand-written SQL. Gated by unit + emit tests
and a real-Postgres round-trip (`hold prior unmanaged view → diff → emit → APPLY → re-diff ==
[]`). Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.

## [0.20.3] — 2026-07-25

**Coordinated release** — npm `0.20.3` · PyPI `0.19.6` · Maven Central `7.11.4` · NuGet
`0.19.4`. The `meta docs` site feature is **npm-only** (TS `docs-site` + `cli`); **#238
(ADR-0046) is cross-port**, so PyPI / Maven / NuGet each release the loader change too. All
changes are additive (PATCH): existing `meta gen` output is byte-identical and no registry
vocabulary is added.

### Added — `meta docs` surfaces prompt TEXT + a prompt data-flow view (site)

The browsable HTML doc site (`meta docs --site`) now shows the actual prompt text and a
directional prompt-construction data-flow diagram (npm-only; `docs-site` + `cli`):

- **`--prompts <dir>`** — the `--site` prompt-source search now includes `<root>/templates/`
  and an explicit `--prompts` dir, so a project whose prompt `.mustache` sources live
  outside `metaobjects/` or `templates/` (e.g. `data/templates/`) renders the actual
  prompt TEXT on each prompt page (with every `{{var}}` linked to its payload field)
  instead of a "source missing" note.
- **Prompt data-flow diagram** on the site index — a directional Mermaid flowchart of the
  pipeline: request payload VO ──input──▶ prompt, prompt/output ──produces/parses──▶
  response VO, and (where a VO references an entity) the DB-entity ──source/persists──
  bookends. Derived structurally from `template.prompt @payloadRef`/`@responseRef` and
  `template.output`/`template.toolcall @payloadRef`, plus each VO's entity references. A
  new `@responseRef` graph edge (prompt → response VO) completes the pipeline.

Additive: markdown surfaces and non-pipeline site output are unchanged. Gated by the
`docs-site` golden (its AI fixture now exercises the full pipeline) + a link-graph unit test.

### Added — value objects may carry navigation-only references (ADR-0046, #238)

A non-persisted shape — an API DTO, an event payload, a wire-protocol command message —
can now declare that a field references an entity, using the chartered navigation-only
reference form. Previously value purity (ADR-0028) banned **all** identity/reference
constructs on `object.value`, so a message carrying `tableId` had no way to say it
references `Table`.

- An `object.value` may now carry an `identity.reference` child **when it declares
  explicit `@enforce: false`** (the already-chartered logical-reference form). The loader
  resolves its `@references` target exactly as on an entity — a dangling target fails the
  load with `ERR_INVALID_REFERENCE` — and codegen emits **no** FK/DDL (a value has no
  table). A value's own identity (`identity.primary`/`identity.secondary`) and any
  enforced reference stay banned (`ERR_SUBTYPE_RULE_VIOLATION`).
- **Zero new vocabulary** — a child-licensing relaxation (ADR-0037 step 0), not an
  expansion; `registry-conformance` is unaffected. The value↔entity dichotomy just gained
  the "referencing DTO" it lacked without a new subtype.
- **M:N junction guard made explicit.** Value purity used to *implicitly* guarantee that an
  M:N `@through` junction was an `object.entity` (a value couldn't hold the two required
  `identity.reference` children). Allowing navigation-only references on values removes that
  implicit guard, so the `@through` validation now explicitly requires the junction resolve
  to an `object.entity` (`ERR_INVALID_RELATIONSHIP` otherwise) — a junction is a physical
  join table.

Additive: no existing metadata triggers the relaxed rule, so `meta gen` output is
byte-identical. This is a **cross-port loader change** (TS / Java / Python / C#; Kotlin
inherits the JVM loader), gated by four new shared conformance fixtures
(`value-reference-navigation-only` loads + resolves; `error-value-reference-enforced`,
`error-value-reference-unresolved`, and `error-m2m-through-value` fail). See
[ADR-0046](spec/decisions/ADR-0046-value-navigation-only-references.md).

## [0.20.2] — 2026-07-25

**npm `0.20.2` only** (NuGet `0.19.3` / PyPI `0.19.5` / Maven Central `7.11.3` unchanged — no changed product file; D1 is a TS-only dialect). A bug-fix patch, no API or vocabulary change.

### Fixed — D1/SQLite `verify` false schema drift (`migrate-ts` + `cli`)

`meta verify --dialect d1` reported permanent, unfixable schema drift for a
hand-migrated D1/SQLite database whose schema genuinely matches its metadata,
because the shared sqlite/d1 diff path compared distinctions SQLite cannot
physically represent. Four fixes, all scoped to sqlite/d1 (Postgres behavior
unchanged) and gated by a new `sqlite-hand-migrated-verify` integration test plus
`parseSqliteChecks` / `normalizeCheckExpr` unit gates:

- **`json` and `VARCHAR(N)` length no longer read as drift.** SQLite/D1 has one text
  storage class — a `field.object @storage:jsonb` column is stored as `TEXT`, and a
  `VARCHAR(N)` length is cosmetic (not enforced). A hand-written bare `TEXT` column is
  the same physical column as the maxLength'd / jsonb one, so the diff now canonicalizes
  `json→text` and drops text `maxLength` on sqlite/d1 before comparing. This also
  corrects `meta migrate`: a metadata-only `maxLength` change on sqlite/d1 now emits no
  migration — nothing physical changes in SQLite.
- **Anonymous inline `CHECK (…)` constraints now reconcile.** Hand-written migrations
  write unnamed inline checks; introspection parses them (previously skipped, and now
  with a mask so a `CHECK (` inside a comment or string literal is never mis-parsed) and
  the diff matches a modeled named check against an actual check by normalized expression
  on sqlite/d1, so an already-enforced constraint is no longer re-proposed as add-check.
  Comma spacing in an `IN (…)` list is normalized *outside string literals only*
  (`'a', 'b'` == `'a','b'`, but a comma inside a literal/regex stays significant).
- **A bare `NULL` default is now no default.** The D1/wrangler runner stringifies a SQL
  `NULL` `dflt_value` to the string `"null"`, which was read as a literal default on
  every no-default column — permanent (and, on SQLite/D1, destructive recreate-and-copy)
  false drift on every `verify`/`migrate`. `DEFAULT NULL` is equivalent to no default; a
  quoted `'null'` stays a genuine string literal.

## [0.20.1] — 2026-07-25

**npm `0.20.1`** (patch; NuGet 0.19.3 / PyPI 0.19.5 / Maven 7.11.3 unchanged). `meta init` quickstart polish: the post-init next-steps no longer lists the working `meta gen` / `meta docs` under "ship in later sub-projects" (only `ingest`/`serve`/`install-hooks` are unshipped), and `meta init` now scaffolds a minimal root `.gitignore` (node_modules/, *.sqlite, dist/) when the project has none, so a `git add -A` right after init does not stage node_modules or a local dev DB. No API or codegen-output change.

## [0.20.0] — 2026-07-25

**npm `0.20.0` only** (NuGet stays at `0.19.3`, PyPI at `0.19.4`, Maven Central at `7.11.3` — those ports have no changed product file). Two first-touch quickstart UX fixes surfaced by a fresh-external-install pressure test; no new vocabulary. MINOR because the codegen import-extension default changes generated output (see below) and `relativeModuleSpecifier`'s signature gains a parameter.

- **`meta migrate baseline` no longer silently traps a greenfield project.** An offline `meta migrate baseline` (without `--from-db`) derives its "already-applied" snapshot **from your metadata**, so on an empty/new database it recorded the entities' target shape as already applied — no `CREATE TABLE` was ever emitted and the generated server 500'd `no such table`, while the CLI reported success at every step. Now `meta migrate baseline` introspects the target `--db` and **refuses** (exit 2, writes no snapshot) when it can prove the database is empty; every other offline baseline still writes the snapshot but **warns** that it emits no DDL. The no-snapshot error hint, the `meta gen` success hint, and `meta migrate --help` all now route to the correct greenfield bootstrap — `meta migrate --from-db --db <url> --dialect <d> --slug init --apply` — instead of the `baseline` subcommand.
- **Generated relative imports are now Node-ESM / `nodenext`-safe by default.** Generated code emitted un-extensioned relative imports (`import { Author } from "./Author"`, `from "../db"`), which fail `TS2835` under a stock `tsc --init` (`module: nodenext`) config — a wall of errors out of the box for a newcomer (the repo's own `moduleResolution: "bundler"` masked it). The `codegen.extStyle` default now flips from `"none"` to **`"js"`** (`import … from "./Author.js"`), and `meta init` scaffolds `extStyle: "js"`. `.js` specifiers resolve correctly under **both** `nodenext` and bundler resolution, so the default is strictly more compatible; opt back out with `extStyle: "none"`. A relative `dbImport` (e.g. `../db`) is extensioned too (`../db.js`). **This changes generated output** — the next `meta gen` on an existing project adds `.js` to relative imports (three-way merge preserves your hand edits); pin `extStyle: "none"` to keep the prior output. Gated by a new nodenext compile gate that type-checks real generated output under a stock `nodenext` program (zero `TS2835`).

## [PyPI 0.19.5] — 2026-07-25

**PyPI `0.19.5` only** (a Python-port docs republish; npm `0.20.0`, NuGet `0.19.3`, Maven Central `7.11.3` unchanged; no product-code change vs `0.19.4`). Republishes the corrected `server/python/README.md` — the live PyPI project page had claimed the distribution ships a `migrate` module (it does not — schema is TS-owned, ADR-0015) and described the runtime as "SQLAlchemy Core" (it is a DB-API 2 `ObjectManager` over pg8000 / psycopg). PyPI versions are immutable, so a fresh version was required to update the page.

## [0.19.4] — 2026-07-24

**PyPI `0.19.4` · Maven Central `7.11.3`.** npm stays at `0.19.3` and NuGet at `0.19.3` — neither port has a changed product file in this release (the TypeScript and C# changes were test-harness/fixture only). No breaking changes, no new vocabulary. Extends the [ADR-0045](spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md) `field.timestamp @autoSet` stamping guarantee from vanilla entities to the **TPH (single-table discriminator) per-subtype API surface** ([#203](https://github.com/metaobjectsdev/metaobjects/issues/203) / [#229](https://github.com/metaobjectsdev/metaobjects/issues/229)).

**Generated TPH controllers now stamp `@autoSet` (Java, Kotlin, Python).** The TPH per-subtype write path is a separate code path in every port and had not inherited the vanilla ADR-0045 stamping: the generated Java Spring controller (`emitTph` delegated raw to the consumer repository interface with no `stampForInsert`), the Kotlin controller (bound `@autoSet` columns straight from the DTO — and would NPE on a `@required` autoSet column), and the Python FastAPI router (omitted the stamp lines) all shipped a deployed TPH API surface that silently dropped `@autoSet`. Each now stamps in the generated per-subtype create/update: a fresh row's `onCreate` and `onUpdate` columns are stamped from one captured `now()` (equal), a PATCH bumps every `onUpdate` column and never rewrites `onCreate`, and caller-supplied `@autoSet` values are ignored. `@autoSet` is excluded from each port's per-subtype settable/validated set so a POST need not supply the server-owned column. C# and TypeScript already stamped on the TPH path (EF route stamping / Zod schema transforms) — verified, no change. A subtype declaring its OWN `@autoSet` column (rather than inheriting from the shared base) is a documented non-goal, compile-safe across all ports. Gated cross-port by a new `tph-autoset-patch` scenario on the shared `api-contract-conformance/tph` corpus, on every port's generated TPH lane plus the TS/C# reference lanes. Output is byte-identical for a TPH hierarchy that declares no `@autoSet` field.

**Vanilla (non-TPH) Java `<Entity>Patch` no longer lets a caller mutate a write-once `@autoSet` column.** The Java `SpringDtoGenerator`'s vanilla settable set excluded the primary key but not `@autoSet` columns, so an HTTP PATCH could overwrite a write-once `onCreate` timestamp. It now excludes `@autoSet` (matching the TPH overload and the Python fix in `0.19.3`); the `onUpdate` column is still server-stamped on every PATCH via `stampAutoSetOnUpdate`.

Per-registry scope: **PyPI** carries the Python TPH router fix; **Maven Central** carries the Java (TPH controller + vanilla patch) and Kotlin (TPH controller) fixes; **npm** and **NuGet** are unchanged (no product file changed — C#/TS already stamped and only their cross-port test lanes were touched).

## [0.19.3] — 2026-07-21

**Coordinated across all four registries:** npm `0.19.3` · NuGet `0.19.3` · PyPI `0.19.3` · Maven Central `7.11.2`. No breaking changes, no new vocabulary. Completes the [ADR-0044](spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md) payload-record collision-naming rollout ([#219](https://github.com/metaobjectsdev/metaobjects/issues/219)) across the remaining ports — the TypeScript and C# half shipped in `0.19.2`.

**Payload record naming is collision-scoped in Python, Java and Kotlin ([#219](https://github.com/metaobjectsdev/metaobjects/issues/219) stages 2–3, [#220](https://github.com/metaobjectsdev/metaobjects/issues/220)).** When two `object.value`s share a bare short name across packages (`acme::alpha::Note` + `acme::beta::Note`, both reachable from one payload by fully-qualified `@objectRef` — valid metadata since ADR-0041/0042), each port's payload generator silently produced the wrong output: **Python** deduped nested classes by `fqn()`, which returns the bare name when a loaded object's own `package` is unset, collapsing the two `Note`s into one `NotePayload` and dropping the second shape; **Java** and **Kotlin** are one-file-per-record emitters, so both records were named `NotePayload` and written to the same path — the second silently **clobbered** the first, last-wins. All three now run ADR-0044's three-pass pipeline: an FQN-keyed reference-closure walk, then name assignment (bare `<Short>Payload` when unique in the artifact's collision domain — the module for Python, the output package for Java/Kotlin; a package-derived name such as `AcmeAlphaNotePayload` for **every** colliding member; hard failure with `ERR_PAYLOAD_NAME_COLLISION` if a derived name still collides), then emission through the name map. **Not breaking** — names change only where output was silently wrong; non-colliding output is byte-identical, pinned per port. The Kotlin xpkg-collision conformance test (#220) is upgraded from asserting a file exists to running the payload generator, asserting two distinct classes, and compiling the output.

**`ERR_PAYLOAD_NAME_COLLISION` promoted to the shared error-code ledger (ADR-0044).** Declared per-port locally through stages 1–3 so registering it before every port implemented the check couldn't redden a port on a code it didn't emit, the backstop code now joins `fixtures/conformance/ERROR-CODES.json` and the central registries that gate against it — TypeScript `errors.ts` (exact bidirectional agreement), Python `errors.py` (superset), Java `ErrorCode.java` (peer of `ERR_VAR_NOT_ON_PAYLOAD`).

Per-registry scope: **PyPI** carries the Python payload fix; **Maven Central** carries the Java + Kotlin payload fixes; **npm** carries the additive `errors.ts` ledger entry only (the TypeScript payload fix itself shipped in `0.19.2`); **NuGet** is a version-parity bump — the C# payload fix and its local `ERR_PAYLOAD_NAME_COLLISION` shipped in `0.19.2` and the C# code is unchanged here.

## [0.19.2] — 2026-07-20

**npm `0.19.2` · NuGet `0.19.2`.** PyPI stays at `0.19.2` and Maven Central at `7.11.1` — neither port has a changed file in this release. No breaking changes, no new vocabulary.

**Generated forms validated edits against the wrong schema, blocking most saves ([#227](https://github.com/metaobjectsdev/metaobjects/issues/227)).** The generated `<Entity>Form` takes `defaultValues` — edit is a first-class mode — but resolved **every** submit against `InsertSchema`. `InsertSchema` optionals are `.optional()`: absent is fine, `null` is rejected. An edit, though, is seeded from a real row whose unset optional columns are all `null`. So editing any row holding a NULL optional was blocked outright: *"Invalid input"* appeared on fields the user never touched, `handleSubmit` never fired, and the save silently did nothing. Since most rows carry at least one unset optional, this broke most edits.

The resolver now switches on the same `defaultValues` presence that already distinguishes create from edit everywhere else in the template. That is the semantically correct pairing regardless of the bug: an edit submits a PATCH, so it validates against the PATCH schema — `UpdateSchema` (`.optional().nullable()`) still enforces min/max/enum on present keys, it just doesn't demand required keys the PATCH isn't sending (FR-035 present-key). TPH forms get the same `.omit(discriminator)` treatment on both schemas. Rejected: normalizing `null → ""` in `defaultValues` (destroys the was-null vs was-empty distinction [#223](https://github.com/metaobjectsdev/metaobjects/issues/223)'s tristate needs, and feeds `""` to controls like `view.image` that expect `string | null`), and loosening `InsertSchema` optionals to `.nullable()` (weakens create-path validation for every consumer, including the server route, to paper over a client-side mode-selection bug). Generated-output change — regenerate to pick it up; three-way merge preserves hand-edits. TS-only; no other port generates forms.

**Three CLI/codegen fixes surfaced by building the canonical advanced-modeling example.** Each was narrowly scoped and independently adopter-visible:

- **`verify --codegen` failed spuriously for any project using template-output generators.** Its throwaway regen root didn't carry the project's `templates/` directory forward, so `render-helper()` had nothing to resolve against and the drift check reported failure on a project with no drift.
- **A relative `outDir` resolved against the ambient `process.cwd()` instead of the resolved `--cwd`** — in both `meta gen`'s write path (`runner.ts`) and `verify --codegen`'s read path (`codegen-drift.ts`). Invoking the CLI from anywhere other than the project root wrote generated code to the wrong place.
- **`render-helper.ts` didn't `stripPackage()` a resolved `@payloadRef`** before emitting it as a TypeScript identifier, producing invalid syntax for any payload declared in a named package.

**Payload record emission is FQN-keyed with collision-scoped naming — TypeScript and C# ([ADR-0044](spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md), [#219](https://github.com/metaobjectsdev/metaobjects/issues/219)).** Two `object.value`s sharing a short name across packages could not both be emitted. TypeScript resolved `@objectRef` correctly (ADR-0042) but then deduped already-emitted interfaces by **bare** name, silently dropping the second (first-wins). C# was worse: it stripped the package *before* resolution and looked the name up in a bare-name-only scan, so the two collapsed onto whichever the scan enumerated first — the wrong shape, silently.

Both ports now run the ADR-0044 three-pass pipeline: an FQN-keyed reference-closure walk, then name assignment (bare short name when unique in the closure; a package-derived name such as `AcmeAlphaNote` for **every** colliding member — declaration, file name and all references; hard failure if a derived name still collides), then emission through the resulting name map. Resolution is always FQN-exact, dedupe always FQN-keyed, and naming a pure function of the closure, so output no longer depends on enumeration order. **Not breaking** — names change only where output is silently wrong today; non-colliding output is byte-identical, pinned by exact-string no-churn tests on both ports. The corpus contract now prohibits hand-authored payload records (it had been papering over exactly this gap), and the TS and C# runners were switched to real generated types with the render pins kept byte-exact.

This lands the TypeScript and C# half. **Python, Java and Kotlin are still affected** by the same class of bug through different mechanisms — Python shadows both classes in one module, Java and Kotlin silently clobber one file — and are tracked as the remaining stages on [#219](https://github.com/metaobjectsdev/metaobjects/issues/219).

## [0.19.1] — 2026-07-20

Coordinated **patch** across all registries: npm `0.19.1` · NuGet `0.19.1` · PyPI `0.19.2` (the Python line is one ahead after its `0.19.1` hotfix) · Maven Central `7.11.1`. No breaking changes, no new vocabulary.

**An explicitly authored `validator.length @min` is now authoritative over the FR-036 Pin 1 implicit floor ([#224](https://github.com/metaobjectsdev/metaobjects/issues/224)).** Pin 1 — *a `@required` non-array string is non-empty* — remains the default, but every port previously clamped the floor with `max(@min, 1)`, so an explicitly authored `validator.length @min: 0` was **silently discarded**: the loader accepted it and the emitter dropped it, leaving *"must be provided, but may be empty"* inexpressible. The clamp, not the opt-out, was the defect — discarding authored metadata is precisely what a metadata-is-the-spine model exists to prevent. Now `@min: 0` on a `@required` string restores presence-only, an explicit `@min: N` always wins, and the implicit floor applies only when no `@min` is authored at all. NOT NULL semantics are untouched.

Fixed in all five ports, each of which must distinguish *"no `@min` authored"* from *"`@min: 0` authored"*. Locked by two new `validation-conformance` cases (`note-empty-allowed`, `note-missing`) running on all five ports, alongside the existing `name-empty` case which proves the default still rejects `""` when nothing is authored. This is additive — no `@min: 0` fixture existed, so it flips zero previously locked verdicts.

**FR-036 §A5 executed — the `@required` vocabulary now matches the shipped behavior ([#224](https://github.com/metaobjectsdev/metaobjects/issues/224)).** §A5 was ordered in `0.16.0` and never carried out, so the registry still described `@required` as plain "NOT NULL" while the emitters rejected empty strings, and `validator.required` contradicted itself ("null/empty" in its description, "present" in its `whenToUse`). An adopter reading the vocabulary would author `@required` meaning presence — which is exactly what happened. Both now state the same semantic: `@required` is NOT NULL; on a non-array string, generated **wire-tier** input validation additionally rejects `""` by default (whitespace accepted) unless an explicit `validator.length @min: 0` opts back to presence-only; in-process read models never enforce at construction. The `metaobjects-authoring` skill, which never defined the semantic at all, now documents it with the opt-out.

**`meta verify` can target Cloudflare D1 ([#225](https://github.com/metaobjectsdev/metaobjects/issues/225)).** `verify --dialect d1 --d1 <binding> [--remote]` resolves the binding from `wrangler.toml` and introspects through the same wrangler transport `meta migrate` already uses, feeding the existing drift reporting and exit codes. Previously D1 had no drift gate at all, and the obvious workaround — pointing `--db file:` at wrangler's local SQLite state — verified the **local** database while printing `schema in sync`, turning an unverified deploy into a verified-looking one. `--db file:` into a `.wrangler/state/**/d1/**` path now warns that it is checking the local database and points at the D1 flags; it never redirects, so the local file does not become a convenient default. Going through the native D1 path also inherits the correct filtering of wrangler-owned tables (`_cf_METADATA`, `d1_migrations`), which the `file:` mirror workaround reported as permanent false drift.

## PyPI [0.19.1] — 2026-07-20 (Python port only)

**Python-only patch.** npm / NuGet stay at `0.19.0`; Maven Central stays at `7.11.0`.

**FR-036 Pin 1 is now scoped to the wire tier ([#224](https://github.com/metaobjectsdev/metaobjects/issues/224)).** Pin 1 — *"a `@required` non-array string is non-empty"* — was applied to **every** generated Python model, including the in-process models for `object.value`. Value objects used as in-process carriers (prompt payload / template slots — never an HTTP input, never persisted) therefore raised `ValidationError` on a legitimately-empty required string. Pin 1 is a **wire-tier** rule by design (it governs POST/PATCH request bodies), so it is now emitted only on the wire models (`<Name>Create` / `<Name>Patch`) and never on the in-process read model. This also closes the same over-application one tier down, where reading an existing row containing `""` could throw at model construction.

So the wire tier keeps validating unchanged, an `object.value` now also emits its own `<Name>Create` wire model (keyed by wire name), and create/patch models reference `<Ref>Create` for value-object-typed fields. Value-object jsonb PATCH validation is unaffected — a nested empty `@required` string still returns `400` (api-contract `jsonb-value-object-patch` r10, all five ports, both lanes).

Behavior change for Python adopters: generated in-process models no longer carry an implicit `min_length=1` for `@required` strings, and value objects gain an additive `<Name>Create` class. Regenerate to pick this up. Other ports are unaffected — their value-object constraints are declarative annotations evaluated only by explicit controller validation, which is already wire-tier.

Known follow-ups (tracked on #224, not in this patch): the `validator.length @min: 0` opt-out is still clamped shut, and it is clamped in **all five** ports — restoring it is a coordinated cross-port change, not a Python fix. FR-036 §A5 (reconciling the `@required` wording in `spec/metamodel/field.json`, the embedded definitions, `validator-definition`, and the authoring skill) is also still outstanding, and is why `@required` still reads as plain "NOT NULL" in the vocabulary today.

## [0.19.0] — 2026-07-19

Coordinated additive **minor** across all registries: npm `0.19.0` · NuGet `0.19.0` · PyPI `0.19.0` · Maven Central `7.11.0`. No breaking changes.

**Image support — a metadata-driven `view.image` form control (TypeScript web).** A `field.string` can now carry a `view.image` child, and the generated `<Entity>Form` (`@metaobjectsdev/codegen-ts-react` `formFile`) renders an upload/crop `<ImageUpload>` widget for it (via a react-hook-form `<Controller>`) instead of a bare `<input>`. The field stores an **opaque storage key** — no image bytes ever cross the MetaObjects wire; the app supplies an `ImageUploadAdapter` (`upload(blob, { store }) → { key }`, `imageUrl(key) → url`) via React context. `view.image` declares up to five presentation attrs — `@aspectRatio`, `@maxEdge`, `@store` (an opaque storage-namespace hint, not infrastructure), `@accept`, `@maxBytes` — all optional. See [`docs/features/image-upload.md`](docs/features/image-upload.md) for the adapter contract, the expected backend (POST → `{ key }`, GET key → bytes with immutable cache, **server-side EXIF re-check**), and the `img-src blob:` CSP requirement.

**New `metaobjects-ui-web` concern provider — a durable cross-port home for presentation-only view attrs.** `view.image`'s attrs and `@rows` (on `view.textarea`) live on a new TypeScript-applied provider (`spec/metamodel/ui-web.json`); the non-TS ports mirror the spec file but never apply it (these are TS-web presentation-only). Core `view.json` still registers **zero** view attrs (FR-033 invariant holds), and the cross-port registry manifest is unchanged (no forced 5-port registration).

**`@rows` un-deferred.** `view.textarea` now honours a configurable `@rows` (the generated `<textarea>` reads it, defaulting to `4`) — previously a fixed `rows={4}`.

**New runtime + client surface (npm):**
- `@metaobjectsdev/runtime-web` — `canvasToJpegBlob`, `reencodeJpeg` (client-side canvas re-encode / EXIF-strip / down-scale) + the `ImageUploadAdapter` / `ImageMeta` types.
- `@metaobjectsdev/react` — `<ImageUpload>`, `<ImageUploadAdapterProvider>` / `useImageUploadAdapter()`, `cropToBlob`, and an optional `./form.css` subpath export (generic `--mo-*` custom properties with fallbacks). `react-easy-crop` is an **optional, lazy-loaded peer** — non-image consumers pay nothing.

Also folds in a `0.18.0` **test-only** fixup: the `@formExclude` registration left two full-metadata-suite tests (field-completeness EXPECTED + metamodel-docs fixtures) red on `main` (the CI fast lane didn't exercise them); regenerated — published `0.18.0` product code was correct, no re-release.

## [0.18.0] — 2026-07-19

Coordinated additive **minor** across all registries: npm `0.18.0` · NuGet `0.18.0` · PyPI `0.18.0` · Maven Central `7.10.0`. No breaking changes.

**Form controls — view-kind dispatch (TypeScript codegen).** The generated `<Entity>Form` (`@metaobjectsdev/codegen-ts-react` `formFile`) now renders the **right control for each field's declared view** instead of a bare `<input>` for every scalar: a `field.enum` with no explicit view renders a `<select>` (dropdown), `view.textarea` renders a `<textarea>`, `view.checkbox` a checkbox, `view.radio` a radio fieldset; everything else keeps the existing typed `<input>`. Dispatched controls carry an `aria-label` (accessible name parity with the scalar path), and the submit button is wrapped in a styled `metaobjects-form-actions` / `metaobjects-form-submit` container. This is a **generated-output change** delivered default-on — regenerate to pick it up; three-way merge preserves hand-edits.

**`@formExclude` registered as first-class vocabulary (cross-port).** The form template already read `@formExclude` (to omit a field from a generated form), but core never registered it — so strict `meta verify` (ADR-0023 sealed registry) rejected it as `ERR_UNKNOWN_ATTR`. It is now registered as a boolean attribute on the `field.*` wildcard in `spec/metamodel/ui.json` (mirroring `@filterable`/`@sortable`) and flows to every port (TS / C# / Java / Kotlin / Python) via the data-driven UI provider — no per-port code. Cross-port registry conformance gates it.

**Deferred (documented):** configurable `@rows` on `view.textarea` — there is no clean cross-port home for an attribute on a TS-only view subtype today (`ui.json`'s `extends` throws where `view.textarea` is deregistered; core `view.json` breaks the FR-033 "core owns zero view attrs" invariant); textareas render a fixed `rows={4}` until a proper design lands. The blank-optional-scalar submit fix is deferred as tristate-aware work (tracked in #223).

## [0.17.1] — 2026-07-18

npm-only **patch** (`0.17.0` → `0.17.1`; PyPI / NuGet / Maven Central unchanged — a TypeScript-only fix). Fixes a real correctness bug in the generated REST surface for **write-through entities** (FR-024 §7 / #214): a write-through entity (writable table + `@role:replica @kind:view` replica + a derived `origin.passthrough` field) had its generated routes read/write only the base table, so `GET` / `POST` HTTP responses OMITTED the derived field. The #214 read-half had shipped in the query layer + the replica view, but the routes layer was left mounting vanilla table CRUD — and no write-through routes test existed, so nothing caught it.

### Fixed

- **`runtime-ts` `mountCrudRoutes` — write-through read-routing.** A new optional `readView` routes the list/get reads AND the post-write re-read on create/update through the replica view, so read-your-writes returns the derived (`origin.passthrough`) columns the base table excludes (#213); writes still target the base table. Absent → byte-identical behaviour for vanilla / TPH entities (no regression).
- **`codegen-ts` `renderRoutesFile` — pass `readView` for write-through entities.** The generated `<Entity>.routes.ts` now imports the entity file's `.existing()` replica-view const and passes it as `readView` to `mountCrudRoutes`. `reference/routes.ts` (scaffold-and-own) delegates to `renderRoutesFile`, so it inherits the fix.

Gated by a new cross-port `fixtures/api-contract-conformance/write-through/` corpus (POST create returns the derived field, GET reads it through the replica view) running on **TS / C# / Kotlin** — the ports whose generated artifact re-reads through the view — plus `runtime-ts` (`mount-write-through`) + `codegen-ts` (`routes-file`) unit tests.

## [0.17.0] — 2026-07-18

Coordinated additive **minor** across all four registries: **npm `0.17.0`** · **PyPI `0.17.0`** · **NuGet `0.17.0`** · **Maven Central `7.9.0`** (Java/Kotlin). Bundles the accumulated projection/view + read-model + prompt work below, plus a full documentation + agent-context skills refresh (the seven `meta init` skills were accuracy-passed and Fable-reviewed, closing a class of stale-vocabulary and calibration defects; the runtime-ui skill gained its missing Python + C# language references). No breaking changes.

### #208 — DDL-ownership escape valves (`@sql` body + `@unmanaged` marker)

Two mutually-exclusive `source.rdb` attributes express *who owns a DB object's DDL* — the escape from "a projection's view is always synthesized from its `origin.*` children" (ADR-0043):

- **`@sql`** — a hand-written view body the tool **registers, fingerprints, and drift-checks but never authors or parses**. The value is the body inside `CREATE <kind> <name> AS …`. It lets a genuinely-irreducible view (recursive CTE, window function, set operation) carry an `extends`-bound identity/fields for row identity and shape *without* the tool mis-synthesizing a wrong base-table passthrough `SELECT` — the **suppression rule** classifies DDL-ownership *before* the derivation decision, closing a silent-wrong-synthesis hole. The `@sql` view rides the existing emit/fingerprint pipeline; a pre-existing unstamped view at its name is `replace-view`-blocked pending the one-time **`meta migrate --allow adopt-view`** adoption ceremony. `@sql` on a writable kind, combined with `@unmanaged`, empty, or combined with `origin.*`/`@filter` is a load error. v1 migrate lowering is `@kind: view` only (matview/proc → an actionable hard error).
- **`@unmanaged: true`** — this DB object (a view **or a table**) is managed elsewhere (Flyway / a hand-migration owns its DDL). `meta migrate` never creates, drops, or drift-checks it (excluded from both the expected and the introspected-actual sides across the online, offline, D1, and `verify` paths); `meta verify --db` reports it as *external (declared)*. An inbound FK from a managed table still resolves the external table's physical name.

**Registration + the six fail-closed loader-validation rules (R1–R6) ship in all five ports** (TS / C# / Java / Kotlin / Python), resolving `MetaSource` accessors following the `@role`/`effectiveKind` precedent (ADR-0039). The five **error** rules (R1–R5) are conformance-gated by shared `fixtures/conformance/` error-fixtures — every port emits the same code per rule (`ERR_SQL_BODY_WITH_UNMANAGED` / `ERR_SQL_BODY_ON_WRITABLE_KIND` / `ERR_BAD_ATTR_VALUE` / `ERR_ORIGIN_UNDER_SQL_BODY`); the R6 `WARN_ORIGIN_UNDER_UNMANAGED` is per-port unit-tested. All migrate/verify **lowering is TS-only** (ADR-0015). An `xhigh` review before merge caught a real offline-`migrate` DROP-for-external-table bug (the offline `planOffline` path did not thread the unmanaged-name set), fixed + regression-tested. Deferred follow-ups: `@dependsOn` for `@sql` views, the matview managed path, and opaque-body column-name verification. Designed in `docs/superpowers/specs/2026-07-17-issue-208-ddl-ownership-escape-valves-design.md`.

### #214 — entity read-view codegen READ half (all five ports)

Completes the read side of the FR-024 §7 entity read-view (#213 shipped the write/schema half — the write table excludes derived `origin.*` fields and the replica view is emitted + migrate-converged). A **write-through entity** (a writable `table` source + a read-only replica `view` source + derived fields) now generates a hybrid read/write surface in TypeScript:

- The entity file declares the `.existing()` replica **view** alongside the write table, plus a Zod read schema whose `z.infer` **is** the read type `<Entity>` — carrying the derived fields the write table omits (`z.infer`, not Drizzle `InferSelectModel`/`$inferSelect`, because a Drizzle view is not a Table and SQLite views don't expose `$inferSelect`; the read schema's nullability mirrors the view columns, exactly like a projection).
- Generated **reads** (`find<Entity>ById` / `list<Plural>` / reverse finders) SELECT from the view; **writes** (`create` / `update` / `delete`) target the table; a create/update **re-reads** the row through the view by primary key (keyed on the full PK) so the returned `<Entity>` carries the derived fields (read-your-writes). Insert/Update stay derived-free (#213).
- The scaffold-and-own reference generators (`meta init`) delegate the write-through variant to the engine composer (like the projection/TPH variants), so the default consumer path is not a silent no-op.

Shared `renderExistingViewDecl` + `renderViewReadZodObject` helpers now back both projections and write-through entities (projection output byte-identical). Gated by a `tsc`-compile test of the real generated output on both dialects + a real-Postgres re-read round-trip.

**The read half is now complete in all five ports** (schema migration stays TS-owned, ADR-0015; the codegen/runtime is per-port). Each port shares the metadata predicates `MetaField.isDerived()` (a field carrying an `origin.*` child) and `MetaObject.isWriteThrough()` (an object owning both a writable-kind and a read-only-kind `source.rdb`), and each write-through path preserves byte-identical output for vanilla entities and projections:

- **Java** (`codegen-spring`, SQL-free): the read `<Entity>Dto` carries the derived fields, the write `<Entity>Patch` excludes them, and a write-through entity emits its controller / repository / filter-allowlist (order-independent). A derived field on a write-through entity carries no client-validation constraints, so a POST-create can omit the view-computed value.
- **Kotlin** (`codegen-kotlin`): a write-through entity emits **two** Exposed objects — a derived-free write `<Short>Table` and a derived-carrying read-only `<Short>View` — and the repository/controller route reads to the view, writes to the table, re-reading by primary key. A derived field on a write-through entity is a nullable, default-null data-class property (the shared read/create body must be able to omit the view-computed value). Gated by a real-H2 read-your-writes test.
- **Python**: `<Name>Create` / `<Name>Patch` exclude the derived fields, and the `ObjectManager` routes reads to the replica view while excluding derived fields from the INSERT/UPDATE column set **and** the `RETURNING` set, re-reading the row through the view by primary key.
- **C#** (EF Core cannot map one CLR type to both a table and a view): a write-through entity emits a derived-free table-mapped write entity **plus** a second view-mapped read model (`<Entity>View`, sharing the write entity's per-field type converters) carrying the derived fields; reads route to the view `DbSet`, writes to the table `DbSet`, with a by-primary-key re-read after create/update. Gated by an EF-Core-8 compile test over a write-through entity carrying a `field.uri` + a jsonb value-object column.

Each port's fan-out was adversarially reviewed before merge; the review caught a recurring cross-port class of bug (a derived field wrongly forced onto the shared create body) in the JVM ports and EF read-model registration gaps in C#, all fixed before merge. A **flattened `field.object`** on a write-through entity is not yet handled in the entity-host view SELECT (scalars, derived joins, and single-jsonb-column value objects are) — a tracked follow-up.

### #207 — projection row-scope `@filter` (a view-level WHERE)

A projection (`object.projection`) can now declare a row-scope `@filter` — a portable `attr.filter` object (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`like`/`in`/`isNull` with `and`/`or`, desugared to canonical `{ field: { op: value } }` at parse time) selecting which rows the derived view returns. It lowers to an outer SQL `WHERE`, the metadata-managed way to express soft-delete / status / type views instead of a hand-written unmanaged view (which is drift, invisible to `verify --db`). Placement mirrors `origin.aggregate @filter` exactly: a `filter`-subtype attr on `object.projection` (the predicate is a LOGICAL derivation, so it lives on the object, not on `source.rdb` — it survives non-RDB lowerings).

- **Registered in all five ports** (TS / C# / Java / Python / Kotlin), `registry-conformance`-gated (`object.projection` now carries the `@filter` attr in the byte-matched manifest), with a `fixtures/conformance/projection-filter` corpus fixture proving it loads + canonical-serializes identically everywhere.
- **Fail-closed validation (cross-port).** A `@filter` field-ref must name one of the projection's own declared fields, and that field must be addressable in a `WHERE`. An **aggregate-derived** ref (`origin.aggregate`/`origin.first`/`origin.collection`) or a **dangling** ref (naming no declared field) is a fail-closed load error (`ERR_BAD_ATTR_FILTER`) — a `WHERE` runs before aggregation, so it cannot see an aggregate (post-aggregate filtering is a separate future `HAVING`). This dangling/aggregate-derived check runs identically in **all five ports** (gated by shared negative conformance fixtures). TS additionally hardens the load (rejecting a non-array `and`/`or`, an empty op-object, and an op illegal for the field's subtype), so a malformed filter fails at load rather than silently dropping the predicate or crashing the view synthesizer.
- **Resolution + lowering (TS-owned, ADR-0015).** The SQL `WHERE` lowering lives in TS (schema is TS-owned). Each field-ref resolves against its `SelectColumn`: a **passthrough** (base OR joined) → `sourceAlias.sourceColumn` (so `WHERE joined.status IS NULL OR joined.status = 1` works across a join); a **computed** (`origin.computed`) field → its inlined expression. A field clause may carry multiple ops (a range `{ gte, lte }`), each AND-composed. The `WHERE` renders after the joins and BEFORE any `GROUP BY`, composing with `origin.first` correlated subqueries.
- **v1 scope: projections only.** A write-through entity read-view (`isWriteThrough`) is excluded by construction — the attr is registered on `object.projection`, not `object.entity` — because a filtered *replica* view breaks read-your-writes totality (write a row, read it back through the filter, it's gone).
- Gated by golden extract+emit tests, the loader validation suite, and a **real-Postgres round-trip** (emit → apply → introspect → re-diff EMPTY, plus a filtered view that returns only the matching subset). Reuses the shipped `attr.filter` desugar + the `ViewFilterClause` renderer (extended with an inlined-expression comparison node for computed refs).

### #195 — four projection read-model origin capabilities (semantic, backend-agnostic)

Projections can now express four common admin/monitoring read-model shapes as metadata-managed, drift-checked origins instead of hand-written unmanaged SQL — each defined as a semantic `rows → value` derivation (the RDB view lowering is one realization). Registered + validated + natively-typed in **all five ports** (TS / C# / Java / Python / Kotlin); the TS `meta migrate` view synthesizer lowers them for Postgres and SQLite (ADR-0015 — schema is TS-owned).

- **`origin.aggregate @agg: any | all`** — a predicate quantifier over the related row-set ("did **any** related turn fail?" / "did **every** one succeed?"). `@filter` is the quantified predicate (required), `@of` is forbidden, the field is `field.boolean`. Empty related set → `any=false` / `all=true` (vacuous truth). Lowered as `bool_or`/`bool_and` (Postgres) / `MAX`/`MIN(CASE …)` (SQLite), phantom-row-guarded + `COALESCE`d to the pinned empty-set value.
- **`origin.aggregate @agg: collect`** — an array rollup of `@of` across the related set (the field must be `isArray:true`, element type = the `@of` column). `@distinct` = set semantics; `@orderBy` sets element order (mutually exclusive with `@distinct`, which orders by value). Empty set → `[]`. Lowered as `array_agg` (Postgres) / `json_group_array` (SQLite).
- **`origin.computed @expr`** — a row-level value computed from the base entity's own fields via a new **`attr.expression`** structured expression tree (a closed node grammar: field/value refs, comparisons sharing the filter op vocabulary, `isNull`/`isNotNull`, `and`/`or`/`not`, `coalesce`). The tree's inferred type must equal the field's declared subType (`ERR_COMPUTED_TYPE_MISMATCH`); an unknown node is a fail-closed load error (`ERR_UNKNOWN_EXPR_NODE`). The flagship case `payload IS NOT NULL` avoids shipping a heavy column. (Retires the `origin.expression` reservation — #159's future arithmetic becomes additive node kinds in this grammar.)
- **`origin.first`** — argmax-then-project: the single related row selected by `@orderBy` along `@via`, projecting its `@of` column ("the latest child's status"). The carrying field must not be `@required` (empty related set → null). Lowered as a **correlated scalar subquery** (`ORDER BY … , child.pk ASC LIMIT 1`) that composes with the view's `GROUP BY`; the related PK ascending is always the deterministic tie-breaker; `@orderBy` nulls sort last.

Shared new attrs `@distinct` (bool) + `@orderBy` (string array); the per-capability validation (conditional presence, field-shape, type-preservation, the closed expression grammar + type inference) and native projection-field typing (`any/all/collect` non-null; `first` nullable) hold identically across all five ports (each with a 20-case validation suite mirroring the reference). A load-time WARN fires when an inflation-sensitive aggregate (`sum`/`avg`/non-distinct `collect`) coexists with ≥2 to-many join branches. Cross-port conformance fixtures cover all five capabilities incl. the zero-related-rows determinism pins. Follow-ups: a `collect` native-array persistence roundtrip gate, the projection array-typing fix (`collect → T[]` in `codegen-ts` — #204), and the "not-migrate-managed" escape-valve FR (see `spec/roadmap.md`).

### Program D — value-object jsonb columns are PATCH-able cross-port

Value-object jsonb columns (`field.object @objectRef @storage:jsonb`, single AND `@isArray`) are now bound → nested-validated → written on `POST` and `PATCH` in **all five ports** (TS / Python / Java / Kotlin / C#), closing the deliberate FR-036 Day-1 simplification (Java/Kotlin/C# previously excluded VO columns from the patch set, so a single-port fix would have broken byte-identical api-contract parity). Nested VO constraints validate in full (a VO string member over `@maxLength`, an empty `@required` member, a present-`null` on a required member → `400 {"error":"validation"}`), identically across ports. The FR-035 tristate holds for VO columns: absent → untouched; present-`null` clears a nullable column but 400s a `@required` one; present-`[]` writes an empty array (distinct from present-`null` → SQL NULL). Gated by `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml` in both lanes (hand-rolled reference server + generated artifact over Testcontainers Postgres), all five ports. A latent TS runtime bug was fixed along the way: the `ObjectManager` validator did not recurse into `field.object` member constraints (nested violations wrote a 201). `field.map` (dict-of-VO), the Kotlin `field.string @dbColumnType=jsonb` open-bag PATCH, and TPH entities with VO columns remain tracked follow-ups.

## [0.16.0] — 2026-07-14

_Coordinated **breaking** release across all four registries: npm `0.16.0` · PyPI `0.16.0` · NuGet `0.16.0` · Maven Central `7.8.0` (full lockstep; the two `angular` packages stay on their `0.6.x` line)._

**⚠️ BREAKING — this release bundles two coordinated breaking changes (FR-035 + FR-036). The single change most likely to surprise an adopter: C# and Python now ENFORCE field constraints over HTTP where they were previously decorative — a POST/PATCH that a prior version silently accepted may now return `400 {"error":"validation"}`.**

### FR-035 — present-key PATCH tristate (mutation surface)

The generated PATCH now distinguishes an ABSENT key from an explicit `null`, identically across all five ports (previously four different behaviors): an absent field is untouched; a present `null` on a nullable column CLEARS it; a present `null` on a `@required` field is `400 {"error":"validation"}`; and a PATCH may omit `@required` fields entirely (no 400). Holds on both the vanilla and the TPH per-subtype update paths.

### FR-036 — cross-port constraint-validation enforcement + semantic pins

- **`@required` string = NON-EMPTY** (reject `null` and `""`, **accept whitespace-only**) — Java/Kotlin no longer reject whitespace (the auto-`@NotBlank` is retired for `@NotNull` + `@Size(min=1)`); C# emits `[Required(AllowEmptyStrings=true)]` + `[MinLength(1)]`; Python emits `min_length=1`; TS was already correct.
- **`validator.regex @pattern` = FULL-MATCH** (the whole value must match) — TS + Python now anchor the authored pattern as `^(?:…)$`; C# `[RegularExpression]` is anchored too (it was not a true full-match for ordered-alternation patterns).
- **C# and Python now enforce field constraints over HTTP** (both were decorative at the wire tier — C# minimal-API never ran DataAnnotations, Python bound `dict[str,Any]`). POST and PATCH now validate present values → `400 {"error":"validation"}` on all five ports, vanilla + TPH.
- **`@maxLength` × `validator.length @max` precedence is strictest-wins** (`min` of the two).
- A missing `@required` value-type field on POST now 400s on every port (previously C# accepted a garbage default); a `@required` field with a server-side `@default`/`@autoSet` (or an auto-generated PK) is correctly OPTIONAL on POST (a POST omitting `createdAt @default:now()` is 201, not 400).

New cross-port conformance gates (validation-conformance + api-contract, both lanes) lock all of the above so it can't silently drift.

## [0.15.21] — 2026-07-13

_npm `0.15.21` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

_Coordinated release: npm 0.15.21 · PyPI 0.15.13 · Maven 7.7.11. **NuGet is unchanged at 0.15.10** — the C# port needed no fix (it already derived the primary-key type correctly, and became the reference the other three ports were fixed against)._

A bug-fix release, sourced from a downstream consumer's adoption report (TypeScript + Cloudflare D1 + uuid primary keys) and then widened by an adversarial review that hunted the same bug *classes* across the whole codebase. Several of these fail **silently and unsafely** — a wrong-row `DELETE`, a cross-schema `DROP VIEW`, a partial-unique index becoming fully unique — and several make `meta migrate` either destroy work or refuse to run at all. **No metadata changes; no new vocabulary.** Existing metadata generates byte-identical output except where it was previously wrong.

### Fixed — data loss and destructive migrations

- **Writable mounts performed a WRONG-ROW write/delete (`runtime-ts`).** Every writable mount coerced the `:id` path param with a helper that numberifies any numeric-*looking* string. On a TEXT/uuid primary key that does not merely miss — it hits a different row: proven against real engines, `DELETE /docs/0123` deleted row `'123'` (bun:sqlite, via column affinity), while on libsql the row became permanently unfindable (404 on GET/PATCH/DELETE). All writable mounts (fastify, hono, ObjectManager, M:N) now resolve the id against the primary key's real column type. Also: a successful DELETE on bun:sqlite previously returned 404 *after* deleting the row.
- **Every incremental `meta migrate` rebuilt every uuid-PK table.** A uuid primary key's physical `DEFAULT` is synthesized at emit time and deliberately not modelled on the expected side, but introspection read it back as a real default — so the diff reported a false `change-column-default` for every uuid-PK table, on every run. On SQLite/D1 (no `ALTER COLUMN`) that recreate-and-copies the whole table, forever. Postgres emitted a bogus `ALTER` instead.
- **`drop-view` was auto-allowed.** An extension's view (e.g. `pg_stat_statements`) or any hand-written view got an un-gated `DROP VIEW` emitted. Now gated behind `allow.dropView`, extension-owned views are filtered via `pg_depend`, and the recreate-pair exemption is keyed by *(schema, name)* — keyed on the bare name, rebuilding `reporting.summary` un-gated a destructive drop of a hand-written `public.summary`.

### Fixed — migrations that could not be applied, or silently did nothing

- **`@autoSet` emitted `DEFAULT now()` on SQLite/D1** — invalid SQL, so *any* entity with the standard `createdAt @autoSet` produced a migration that could not be applied at all.
- **Changing `field.enum @values` never migrated on SQLite.** CHECK constraints were create-time-only and no change kind triggered the recreate path, so `meta migrate` reported "No schema changes" while inserts of the new member kept violating the stale CHECK in production. (`--allow drop-check` was also *rejected* by CLI arg validation, making Postgres CHECK evolution ungrantable.)
- **`@kind: storedProc` projections crashed `meta migrate` outright**; `@kind: materializedView` silently created a plain view under the materialized view's name.
- **D1 introspection didn't exclude Cloudflare/wrangler tables.** `_cf_METADATA` appears after any write and D1's authorizer denies even `pragma_table_info` on it, aborting every *second-and-later* `meta migrate --dialect d1`; `d1_migrations` read as an undeclared table, so the diff proposed dropping wrangler's own bookkeeping.
- **Infra-table exclusions used `_` as a literal when it is a `LIKE` wildcard** — so `'__new_%'` also matched an ordinary table named `renewals`, hiding it from introspection and re-proposing `CREATE TABLE` forever.

### Fixed — silently wrong SQL and types

- **The SQLite emitter dropped index `@expr` / `@where` / `@orders`.** An expression index emitted `CREATE INDEX x ON t ()` (invalid SQL), and a **partial UNIQUE index became a FULL UNIQUE constraint** — silently rejecting inserts the model says are valid.
- **Boolean/numeric `@default` literals were quoted on SQLite** (`DEFAULT 'false'`), which SQLite stores as TEXT in a numeric column, so `WHERE flag = 0` silently matched nothing. Literals containing a quote (`"don't"`) or parentheses (`"n/a (unknown)"`) never round-tripped either.
- **FK constraint names never converged on SQLite** (the engine stores none), so a composite FK or `@constraintName` produced a permanently blocked `drop-fk` and `meta migrate` exited 1 forever.
- **`@isArray` on any scalar but string/uuid** generated a Drizzle `.array()` column against a migrated SCALAR column — the first insert failed, with no drift signal.

### Fixed — generated code hardcoded the primary-key type (Java, Kotlin, Python)

An entity declaring `identity.primary @generation: uuid` got broken generated output while its own DTO/model correctly used UUID. Not a metamodel gap — a missed reuse: each port already had the type mapper and was already using it a few lines away.

- **Kotlin: the generated code did not compile.** `@PathVariable id: Long` against an Exposed `Column<UUID>` is a type error, and FK columns hardcoded `long(...)`, so *any* relationship pointing at a uuid-PK entity broke the build. Also: the FR-009 filter coercer had no uuid arm (`filter[id][eq]=<uuid>` would have thrown at runtime), and TPH `writableFields` hardcoded the literal `"id"`.
- **Java:** `@PathVariable Long id` → Spring rejected a uuid path variable with 400, and the generated repository interface was un-implementable against a UUID-keyed entity.
- **Python:** the generated FastAPI router typed every path id `int`, so a real uuid was rejected with **422** by Pydantic and never reached the handler — the endpoint was simply unusable.
- **TypeScript:** the TanStack hooks hardcoded `id: number` (including the M:N `sourceId`), so consumer call sites failed to typecheck; and the generated grid hook failed under `noUncheckedIndexedAccess`.

### Fixed — drift gates

- **`meta verify --templates` skipped `@kind=email` templates** — mustache↔payload drift in an email's subject/body was only caught later at `meta gen`. (TypeScript and Python; the Java and C# CLIs still have this gap — tracked in #193.)

### Notes

Every migrate fix is now gated by an `emit → apply to a real engine → introspect → re-diff must be EMPTY` round-trip, plus value-semantics probes (insert the defaults, ask the engine what it actually stored). The absence of that gate — nothing ever ran the pipeline twice against a real database — is what let this whole class survive a large test suite. Two goldens were found to be *encoding* the bugs they pinned and were corrected against real-engine evidence rather than regenerated.

## [0.15.20] — 2026-07-12

_npm `0.15.20` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

_Coordinated release: npm 0.15.20 · PyPI 0.15.12 · NuGet 0.15.10 · Maven 7.7.10._
_**BREAKING** — ADR-0042 bare-reference resolution; see Migration below. Shipped as a PATCH with the breaking notice in this entry (the pre-1.0 convention used by the 0.15.1 / 0.15.17 breaking releases), not signalled via the version number._

### Changed

- **BREAKING — [ADR-0042](spec/decisions/ADR-0042-bare-references-are-package-local.md): bare references are package-local.** A bare metadata reference (no `::`) now resolves in the referrer's package only, else a root-level (empty-package) object; every cross-package reference must be fully qualified. This retires ADR-0041's one-week-old "unique-anywhere" bare resolution (a bare ref silently binding across a package boundary), resolving the ADR-0032/ADR-0041 contradiction. The contract is uniform across every ref-bearing attribute — `@objectRef` (relationship / `field.object` / `field.map`), `@references`, the origin `@from`/`@of`/`@via` heads and hops, `@payloadRef`/`@responseRef`/`@parameterRef`, and now **`@through`** (brought into the desugar + ref set); `extends` is unchanged. Coordinated + conformance-gated across all five ports (TS / Python / Java / Kotlin / C#). Fixes #191.

### Removed

- **`ERR_AMBIGUOUS_REF` is retired.** With bare = package-local, cross-package ambiguity is unreachable; replace any handling of it with the per-attr unresolved codes (below).

### Added

- **`ERR_UNRESOLVED_OBJECT_REF`** — a dangling `field.object` / `field.map` `@objectRef` (present but resolving to no object) now fails closed at load, naming same-short-name objects in other packages so you can qualify it. Previously such a ref loaded clean and surfaced four layers downstream as a misleading `ERR_VAR_NOT_ON_PAYLOAD` (#191).

### Fixed

- **`meta verify --templates` now drift-checks `template.output @kind=email` and document-output bodies (#193).** The check gated on `@textRef`, so email templates (which use `@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) were skipped and a mustache `{{field}}` that drifted from its `@payloadRef` was only caught later at `meta gen`. Every renderable ref is now verified against the payload.

### Migration

- **Qualify every cross-package reference with its package (FQN).** A bare reference that previously resolved to an object in another package now fails to resolve — the error hands you the exact FQN to write. YAML-authored models are unaffected (a bare ref already folds to the current package); this only affects hand-written canonical JSON that relied on unique-anywhere, or code handling the removed `ERR_AMBIGUOUS_REF`.

## [0.15.19] — 2026-07-11

_Coordinated release: npm 0.15.19 · PyPI 0.15.11 · NuGet 0.15.9 · Maven 7.7.9. Additive, non-breaking._

### Added

- **`origin.aggregate @filter`** — a scoping filter (an `attr.filter` object) on an aggregate origin, restricting which related rows the aggregate spans; rendered as SQL `FILTER (WHERE …)` (Postgres) / `CASE WHEN` (SQLite). Registered across all five ports + registry-conformance, with a new `origin-aggregate-filtered` conformance fixture. Closes the "projections can't express my scoped aggregate" gap (the attribute was previously codegen-local and failed strict load under ADR-0023).
- **Downstream metadata-decisions guide** (`docs/features/downstream-metadata-decisions.md`) — the judgment layer for extending the metamodel: exhaust existing vocab, converge-before-inventing (don't claim the chartered `api`/`operation`/`surface`/`binding` names), the ADR-0037 ordered test, and the design rules that make downstream vocabulary age well (protocol/address-free nodes, names-only fail-closed config, reference-typed payloads, the register→extend→promote lifecycle).

### Changed

- **Projection / DB-view guidance made explicit across the agent-context skills + docs.** A projection's `CREATE VIEW` DDL is generated from its `origin.*` children by the Node `meta migrate` — hand-writing a view for a shape origins can express is drift, and because an unmodeled DB view is *unmanaged* it is invisible to `meta verify --db`. Bounded the "custom SQL views" hand-write exception (codegen skill + `codegen-concepts.md`) to genuinely-irreducible views (recursive CTEs, window functions, set ops). The `metaobjects-audit` skill gains a **view-necessity** drift signature and a **VOCAB CANDIDATE** rule that flags where an app should register new vocabulary (a custom subtype/attr via a provider) instead of hand-coding a recurring pattern. Strengthened `metaobjects-authoring` with the extend-decision lifecycle.

## [0.15.18] — 2026-07-10

_npm-only patch (14-package lockstep). PyPI / NuGet / Maven unchanged — these are TS-only fixes. Non-breaking; advances the 1.0 quiet period._

### Fixed

- **`codegen-ts` `promptRender` emitted invalid TypeScript for FQN `@objectRef` payload refs.** A `template.prompt` payload value-object nesting a `field.object @objectRef` to another value-object leaked the fully-qualified name (`pkg::Name`, FR-032/ADR-0041) into both the emitted field type and the generated interface name — `::` is not a valid TS identifier. Now stripped to the bare name (retaining the FQN only for resolution/recursion), matching `entityFile`. Surfaced by dogfooding a package-declared consumer.
- **agent-context skills** — four of six `metaobjects-*` skills had invalid YAML front-matter (an unquoted `:` inside `description:`) so they never intent-triggered under a strict-YAML loader; the C# codegen reference documented non-existent flags; the reference-fragment install was reverted from deploy-all to stack-scoped; deprecated `@metaobjectsdev/codegen-ts/generators` imports and singular tanstack route paths were corrected; and the ADR-0040 `index.lookup` vocabulary was added to the audit capability-checklist + verify migration doc. Also repaired a stale Kotlin `@Serializable`→Jackson reference fixture that had left `agent-context-conformance` red on `main`.

### Added

- Cross-port regression tests (Python + Kotlin) pinning that payload codegen strips an FQN `@objectRef` to the bare name — the bug was TS-only (Java and C# already had equivalent coverage). (#190)

## [0.15.17] — 2026-07-09

_Coordinated release across all four registries: npm `0.15.17` (14-package lockstep) · PyPI `metaobjects 0.15.10` · NuGet `MetaObjects* 0.15.8` · Maven Central `com.metaobjects:* 7.7.8`. Three merged efforts: the breaking `origin.passthrough` type-preservation metamodel change (#185/#186), typed value-object jsonb columns across all ports (#187), and load-order-independent super-resolution (#188/#189)._

> ⚠️ **BREAKING (despite the patch version — pre-1.0):** `origin.passthrough` is now **type-preserving**. Metadata where a passthrough field's declared type differs from its `@from` source (e.g. a `field.uuid` source surfaced as `field.string`) now **fails to load** with `ERR_PASSTHROUGH_TYPE_MISMATCH`. The narrow `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH` is retired. **Migration:** declare the source's type (usually the fix), or add `@convert: true` to acknowledge a deliberate type change. See the Changed entry below.
>
> **Also fixed a latent build-portability bug (#188):** a dotted `extends: Owner.member` targeting an inherited member could fail with `ERR_UNRESOLVED_SUPER` under one directory-scan order but not another (Node vs Bun) — resolution is now order-independent. If a corpus failed to load only under Bun/CI, this release fixes it.

### Added
- **`@convert` on `origin.passthrough` — acknowledge a deliberate passthrough type change (#185).** A new optional boolean attr. Absent/false (the default), a passthrough is type-preserving (see Changed, below); `@convert: true` opts a field out of the type-equality check when its type intentionally differs from its `@from` source. It is an **acknowledgement only — it does NOT generate a cast**; the value flows through unchanged and the consumer owns any coercion. Real type-converting projections remain `origin.expression`'s job (#159). Registered on `origin.passthrough` in all five ports (cross-port registry-conformance gated).
- **Typed value-object jsonb columns work end-to-end across all persistence ports (single + array-of-VO).** A `field.object @storage:jsonb` column — a single value-object OR an `@isArray` array-of-VO — now round-trips through every port's runtime/ORM write+read codec (TS Kysely, C# EF Core, Java OMDB/Gson, Kotlin Exposed, Python pg8000). Gated by a new array-of-VO dimension in the persistence-conformance `AllTypes` `op: roundtrip` scenario: a `labels` column (`field.object @isArray @storage:jsonb`) written as a 2-element, empty-`[]` (≠ `null`), and single-element array across three rows — the gap that had let a non-compiling / wrong array serializer ship in three ports. The single-VO jsonb path was already cross-port green; this closes the array-of-VO half.

### Fixed
- **Load-order-independent super-resolution for dotted `extends` to an inherited member, all five ports (#188).** Deferred super-resolution ran a single pre-order walk over the physical declaration tree, so a dotted ref to an INHERITED member (`extends: Owner.member` where `Owner` inherits `member` via its OWN `extends`) only resolved when the owner's extends chain happened to be wired first — green under one directory-scan order, `ERR_UNRESOLVED_SUPER` under another (Node vs Bun `readdir`). Resolution is now ON DEMAND with memoization + cycle detection: before a dotted ref reads the owner's effective `children()`, the owner's whole extends chain is resolved first, and the resolved target's chain is resolved too (multi-level inheritance). The result is a pure function of the source SET, independent of enumeration order. The TS SDK's `listMetadataFiles` also sorts its raw `readdir` entries so every declaration-order-preserving artifact (serialization) is stable across runtimes — a deterministic-enumeration floor (the other ports' directory sources already sort). Tier-1 invariants are unchanged (`ERR_UNRESOLVED_SUPER` / `ERR_EXTENDS_TARGET_MISMATCH`, failure envelope, target-mismatch contract byte-identical). Gated by a new `extends-dotted-inherited-member-load-order` conformance fixture (RED→GREEN in every port) + a TS shuffle-invariance test (six permutations → identical model) + a duplicate-failure regression test.
- **C# / Java / Python array-of-VO jsonb write+read codecs.** C# EF Core model finalization threw `'ICollection must be a non-interface reference type'` on an `@isArray` `field.object @storage:jsonb` column — `DbContextGenerator` now emits `.OwnsMany(...).ToJson(...)` when `field.ResolvedIsArray()` (the `EntityGenerator` emits `ICollection<VO>`), with a coupled empty-`[]`-vs-`null` nullability fix. Java OMDB threw `Expected BEGIN_OBJECT but was BEGIN_ARRAY` — `GenericSQLDriver.deserializeJsonb` now branches on `isArray` (target `TypeToken.getParameterized(List.class, VO)` via `jsonbTargetType`) and the read path stores the resulting `List` through `setObjectArray` (not the scalar `setObject`). Python's `_coerce_write_value` now `json.dumps`s both dict and list jsonb-storage `field.object`/`field.map` values to a JSON text string — pg8000 binds a native `dict` to jsonb fine, but adapts a native `list` as a Postgres ARRAY literal (`{...,...}`) which the JSONB column rejects with `22P02`.

### Changed
- **Kotlin codegen moved to Jackson for typed jsonb columns; entity/value/projection classes dropped `@Serializable`.** `KotlinExposedTableGenerator` now emits a per-package `MetaJsonbMapper.kt` — a `com.fasterxml.jackson.databind.ObjectMapper` (`kotlinModule()` + `JavaTimeModule()`, `WRITE_DATES_AS_TIMESTAMPS` disabled) — that the generated `jsonb()` column codecs read/write through (a `TypeReference<List<VO>>` captures the array-of-VO generic). Jackson (not kotlinx) is the codec precisely so generated entity/value/projection data classes carry **NO `@Serializable`** and need **NO `kotlin("plugin.serialization")` compiler plugin**: a kotlinx `VO.serializer()` would require the plugin, and once it is on, every VO carrying a `java.util.UUID` / `java.time.*` / `java.math.BigDecimal` / `java.net.*` field fails to compile (kotlinx has no serializer for those `java.*` types). `@Serializable` is **kept** only on prompt payloads + enums (genuinely kotlinx-decoded by the FR-006 output parser). Consumers generating any typed jsonb/`field.map` column add `jackson-databind` + `jackson-module-kotlin` + `jackson-datatype-jsr310` (documented in `docs/ports/kotlin.md` + `codegen-kotlin/KNOWN_GAPS.md`); the open-bag `field.string @dbColumnType:jsonb` column stays on the kotlinx `JsonElement` lane. New gate: compile-WITHOUT-the-serialization-plugin + Testcontainers-PG roundtrip of a GENERATED typed-jsonb table (`GeneratedTypedJsonbRoundTripTest`).
- **BREAKING — `origin.passthrough` is now type-preserving: a passthrough field must match its `@from` source's type (#185).** A field carrying `origin.passthrough @from: "Entity.field"` forwards another field's value unchanged, so its declared `field.<subType>` and array-ness must be identical to the resolved source field. A divergence now fails load with `ERR_PASSTHROUGH_TYPE_MISMATCH` (e.g. a `field.uuid` source surfaced by a projection as `field.string` — the exact mismodeling that forces hand-written `String↔UUID` bridging and defeats a UUID migration). The check compares **subType and array-ness only — nullability is deliberately not judged** (a view over an outer join legitimately widens `NOT NULL` → nullable). Opt out of a deliberate type change with `@convert: true` (see Added). This **generalizes and retires** the narrow, stored-proc-parameter-ref-only `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH` (FR-015) into one host-agnostic invariant covering projections, entities, values, and parameter refs alike. Enforced in the loader/verify in all five ports (TS / Python / C# / Java / Kotlin), cross-port conformance-gated. **Migration:** if load newly fails, the error names both the declared type and the source type — declare the source type (usually the fix — the projection was wrong), or add `@convert: true` if the divergence is intentional.

## [0.15.15] — 2026-07-07

_npm `@metaobjectsdev/sdk` + `@metaobjectsdev/cli` `0.15.15` (isolated patch; the other 12 packages stay `0.15.14`). Ships updated agent-context skills — a docs/content change bundled into the SDK and delivered through the CLI (`meta agent-docs` / `meta init`). No runtime or generated-code change; PyPI / NuGet / Maven are unaffected._

### Changed
- **Agent-context skills now teach the correct direction for a brownfield migration/adoption (#183).** The `metaobjects-*` skills were framed greenfield-only ("metadata is the spine, generated code is disposable"), which licensed a backward loop: change metadata → regenerate → fix the resulting errors in existing code as if they were bugs. When adopting MetaObjects onto existing working code / a live database, the direction reverses — **metadata FOLLOWS the code**: author metadata + tune codegen to reproduce the existing native types, names, and nullability; minimize churn to code the generator isn't replacing; ask on ambiguity; default to the least existing-code change. `metaobjects-authoring` gains the adoption-direction section + a hardened UUID rule (`field.string` + `@dbColumnType: uuid` is a forbidden smell that generates a `String` over a uuid column — use `field.uuid`); `metaobjects-audit` promotes UUID-as-string from non-failing advisory to a real correctness-adjacent finding (axis H2) with blast-radius counting; `metaobjects-codegen` adds "make codegen match the code, not the code match codegen"; `metaobjects-verify` documents the semantic-mismodeling gap + a project-local CI ratchet lint; the always-on doc carries a one-line direction principle.

## [0.15.14] — 2026-07-07

_npm `0.15.14` (TypeScript, full lockstep). A codegen bug-fix patch. Java/Kotlin (Maven) carry no production change and stay on their current line; PyPI `0.15.9` and NuGet `0.15.7` ship the same fix on their own lines._

### Fixed
- **Nested `@objectRef` now resolves FQN-exact across ports (ADR-0041).** The `verify --templates` prompt-drift gate and the render-helper payload field-tree derivation resolved a nested `field.object` `@objectRef` by BARE short-name, so a fully-qualified ref (`pkg::Name`) bound the WRONG same-named `object.value` on a cross-package short-name collision — emptying the element subtree and raising a spurious `ERR_VAR_NOT_ON_PAYLOAD` on its inner `{{fields}}`. The CLI verify walk (`payload-field-tree.ts`) and the docs-source annotator (`template-payload-tree.ts`) now route through the shared `refMatchesObject` resolver (FQN-exact when the ref contains `::`, else bare short-name first-wins); the render-helper resolver was already FQN-safe. The Python and C# render-tier walks also key their cycle guard by the fully-qualified name so a nested collision chain isn't falsely deduped. Gated by a new multi-package `xpkg-collision` sub-corpus under `fixtures/template-output-render-conformance/` that also drives the Python / C# / Kotlin render-helper conformance runners. (#182)

## [Maven 7.7.6] — 2026-07-06

_Maven Central `7.7.6` (Java + Kotlin, lockstep). A Kotlin-codegen-only patch — npm / PyPI / NuGet are unaffected (they carry no Kotlin) and stay on their current lines._

### Fixed
- **`codegen-kotlin` folds TPH (table-per-hierarchy) discriminator subtypes into the base — no dead per-subtype artifacts (#180).** A discriminator base already emitted the union table + data class + enum + polymorphic controller, but five other generation paths still emitted dead, partly non-compiling per-subtype artifacts (`<Sub>Table` mapping the same physical table with a partial column set; a phantom per-subtype inverse FK from `buildGlobalFkMap`; dead `<Sub>` data class / filter allowlist / validator registry entry / relations helper — the latter referencing the folded-away `<Sub>Table`). Every entity-iterating generator now skips `isTphSubtype` (matching the controller), and the base union emits the enum class for any subtype-only `field.enum` it folds in. Brings Kotlin in line with the Java (`codegen-spring`) port. Gated by an expanded snapshot fixture + a full-suite compile test (Exposed + Spring).
- **`codegen-kotlin` generated controller now filters `@filterable field.enum` columns (#179).** The Exposed enum column is typed `Column<Enum>`, but the controller emitted `col eq (p.value as <BareEnum>)` — an unresolved un-prefixed enum type + a `String`→enum cast — so any filterable enum column produced a non-compiling controller. Enum columns are now filtered by their stored string via `CAST(col AS text)` (`castTo<String>(TextColumnType())`), matching every other port's string-band enum-filter semantics (`eq/ne/in/like/isNull`). Gated by a compile-and-run test (eq/ne/in/like against Postgres-mode H2 over MockMvc). Non-enum controllers stay byte-identical.

## [0.15.13] — 2026-07-05

_npm `0.15.13` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta docs --site` renders every remaining authored `@attr`.** Building on the `view.*` attr rendering (0.15.12), the site now documents relationship `@onDelete`/`@onUpdate`, origin `@of`/`@agg`/`@filter`, a view source's `@view`, grid `@layout` attrs, object-level `@attrs` (e.g. a consumer's `@dataflow`/`@neo4j`), field-level `@attrs` (`@column`/`@storage`/…), identity `@constraintName`, and non-standard template attrs on prompt + output pages. A generic `otherAttrs` catch-all consumes + renders whatever a bespoke renderer doesn't, so a consumer's own metamodel vocabulary is documented from a bare registration and new attrs never silently go un-rendered. On a real ~280-page model, coverage now reports zero "not rendered by any page" warnings.

## [0.15.12] — 2026-07-05

_npm `0.15.12` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta docs --site` renders a field's `view.*` subtypes + their attributes.** Object pages now show each field's presentation view children (`view.currency`/`view.badge`/`view.meter`/`view.duration`/…) as a per-field sub-row — `view.<subType>` badges plus `@attr=value` pairs (object-valued attrs like `@variantMap` render as sorted `k: v` lists). The field builder consumes the view node + its `ownAttrs`, so they no longer surface as "not rendered by any page" in coverage. Attrs are read directly off the node, so a custom view subtype registered via `extraProviders` renders its attrs from a bare registration (no per-attr schema needed in the consumer's provider).

## [0.15.11] — 2026-07-05

_npm `0.15.11` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **`meta docs --site` resolves cross-file overlays.** The site loader fed metadata via `fromDirectory`, whose `DirectorySource` sorts by basename (a cross-port ordering contract). A base object in a top-level file plus an `overlay: true` extension in a subdir whose basename sorts earlier parsed the overlay before its base and failed with `ERR_OVERLAY_NO_TARGET` — even though the sdk's `loadMemory` (and thus `meta gen`/`migrate`) loads the same model fine via files-before-subdirs. The site loader now collects files-before-subdirs and feeds `MetaDataLoader.load` directly, leaving the cross-port `DirectorySource` order untouched. `acme` golden byte-identical.

## [0.15.10] — 2026-07-05

_npm `0.15.10` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **`meta docs --site` now honors `metaobjects.config.ts` `providers`.** The HTML site surface had its own loader (`docs-site`'s `loadModel`) with a fixed provider registry, so a model using consumer subtypes (custom `field.*`/`view.*`/`object.*` registered via a project's `providers`) failed on `--site` alone with `Unknown type "…" — not registered`, even though the markdown surfaces (which load via `loadMemory`) resolved them. `docs-site`'s `loadModel`/`generateSite` gain an additive `extraProviders` option (composed after the built-in bundle, mirroring `loadMemory`'s `providers`), and the CLI threads the config's `providers` into the site path. Additive — config-less callers are unchanged (the `acme` golden is byte-identical).

## [0.15.9] — 2026-07-05

_Coordinated cross-language release: npm `0.15.9` (full lockstep across all `@metaobjectsdev/*` publish candidates) · PyPI `0.15.8` · NuGet `0.15.6` · Maven Central `7.7.5`. A new cross-language reference-resolution contract (ADR-0041)._

### Added
- **Cross-package reference resolution contract (ADR-0041), all five ports.** Every reference that names another object — `@objectRef` (relationship + `field.object`), `@references`, the `@from`/`@of`/`@via` heads of `origin.*`, `extends`, a relationship's `@through`, and `@payloadRef`/`@responseRef` — now resolves under one shared, conformance-gated contract: **a fully-qualified reference (`pkg::Entity`) resolves EXACTLY to its package** (never a bare-tail fallback), and **a bare reference prefers the referrer's own package, else a unique object of that name anywhere, else `ERR_AMBIGUOUS_REF`** (new error). New `fixtures/conformance/xpkg-*` / `error-xpkg-*` corpus covers every ref-bearing attribute cross-package plus the collision cases; all five ports serialize/err byte-identically.

### Fixed
- **Java resolved an explicit FQN to the wrong same-named package.** `SymbolTable.nameMatches` / `ValidationPhase.nameMatches` matched the reference's bare *tail* before the exact-FQN check, so with same-named entities in different packages an explicit `pkg::Entity` silently bound a different package's entity (wrong FK table). FQN references now resolve exactly. Kotlin bare-name collisions were arbitrary first-match; the shared loader fix corrects both.
- **Java M:N derivation/runtime resolvers had the same FQN-discard bug.** `M2MFields` (the FK-derivation SSOT) and the OMDB runtime `M2MResolver` stripped an FQN `@objectRef`/`@through` to its bare tail — mis-classifying a cross-package hetero M:N as a self-join / binding the wrong junction. They now resolve by exact FQN + resolved object identity.

**Potentially breaking:** a model that today relies on a *bare* reference silently binding an arbitrarily-chosen same-named entity in another package now fails with `ERR_AMBIGUOUS_REF` — previously undefined, port-divergent behavior. Fix by qualifying the reference with its package (FQN). No change for unique names or explicit FQNs. The remaining bare-collision *same-package preference* in codegen/runtime is tracked as a follow-up (#174).

## [0.15.8] — 2026-07-04

_npm `0.15.8` (full lockstep across all `@metaobjectsdev/*` publish candidates, now including the new `docs-site` package). A TypeScript-only release — NuGet stays at `0.15.5`, Maven Central at `7.7.4`, PyPI at `0.15.7`._

### Added
- **`@metaobjectsdev/docs-site` — a browsable HTML documentation-site generator, wired as `meta docs --site`.** Generates a multi-page site from metadata alone (package nav, Cmd+K search, per-object/package/prompt/output pages, kind-aware ER diagrams that encode object kind by shape + domain by color); deterministic + link-checked. `--site` is additive to the markdown `--model`/`--api` surfaces (alone, it suppresses markdown). Relationship edges are sourced from the shared relationship IR, so the diagrams cover M:N-through-junction (the junction is kept as a node **and** a distinct M:N edge is drawn), directed + symmetric self-joins, belongs-to cardinality, and `@onDelete`. **`meta docs --scaffold-site`** copies the templates + CSS/JS into `codegen/docs-site/` (ADR-0034 scaffold-and-own, write-only-if-absent) so a consumer owns its theme; `meta docs --site` auto-detects the owned copies (bundled fallback).

### Fixed
- **metadata — `deriveM2MFields` resolves the M:N `@through` junction by FQN as well as bare name.** The TS port looked the junction entity up by bare name only, so a fully-qualified `@through` (the codebase convention) threw and callers silently dropped the M:N relation — affecting both the new docs graph and `codegen-ts`'s `buildRelationMap`. It now falls back FQN → package-stripped, matching the Python and Java/Kotlin ports, which already handled both forms.
- **docs-site — `.js` extensions on relative imports (Node ESM compatibility).** The package initially shipped extensionless relative imports (Bun-tolerant, Node-rejected), so `meta docs --site`/`--scaffold-site` crashed from a real Node install even though every in-workspace bun test passed; all relative imports now carry the `.js` extension every sibling package already uses.

## [0.15.7] — 2026-07-04

_npm `0.15.7` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates). A TypeScript-only patch — NuGet stays at `0.15.5`, Maven Central at `7.7.4`, PyPI at `0.15.7`._

### Fixed
- **codegen-ts — generated Drizzle DAOs failed `tsc` under `verbatimModuleSyntax` (#165).** The default `entityFile()` output imported Drizzle's type-only symbols as value imports — `InferSelectModel` / `InferInsertModel` (`drizzle-orm`) and `AnyPgColumn` / `AnySQLiteColumn` (`*-core`, used only as a `.references()` return-type annotation). Under `verbatimModuleSyntax: true` (a common default in modern Vite/TS app templates) tsc rejects each with **TS1484**, so a generated DAO failed `tsc -b` with hundreds of errors even though it ran fine under a bundler. Those symbols now emit as type-only imports (`import type` / inline `type` modifier), fixing both the built-in generator and the ADR-0034 scaffold-and-own reference template. Gated by a real-`tsc` compile guard with `verbatimModuleSyntax` on.
- **CLI — `meta init --refresh-docs` re-scaffolded the project and regressed stack detection in a monorepo (#163).** `--refresh-docs --force` fell through to a full project re-scaffold (re-creating `metaobjects/`, `metaobjects.config.ts`, `codegen/generators/`, config, manifest — and scaffolding into sibling packages) because the refresh short-circuit was gated on `!force`; refresh now short-circuits regardless of `--force`, which instead means "overwrite hand-edited docs in place." And refresh re-detected the tech stack from a root-only probe — collapsing a monorepo's `java, kotlin server, react, tanstack client` to `java server, no client` (sibling-package client deps and Maven-built Kotlin are invisible at the root) — so it now reuses the stack persisted in `.metaobjects/.agent-context.json` (precedence: explicit `--server`/`--client` > persisted manifest > detection).

## [0.15.6] — 2026-07-04

_Coordinated cross-port patch: npm `0.15.6` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates) · PyPI `0.15.7` (Python stays a patch ahead) · NuGet `0.15.5` · Maven Central `7.7.4`. A loader-ordering bug-fix that hardens a latent fragility in every port._

### Fixed
- **Loader — an overlay-only file could be merged *before* the base file that declares the entity it re-opens, breaking order-dependent super-resolution (all four loader ports).** When a directory scan surfaced an `overlay: true` file ahead of the file declaring the base object (e.g. a top-level `meta.a-presentation.json` presentation overlay sorting before a subdir `meta.z-model.json` base), the overlaid node preceded the entities it depends on — so `object.projection` re-opens (and any overlay reaching for a not-yet-loaded `extends`/`origin` target) failed to resolve, producing spurious `ERR_INVALID_ORIGIN` / `ERR_UNRESOLVED_SUPER` / `ERR_MISSING_REQUIRED_ATTR`. This surfaced as a **cross-port divergence** — the TS loader tolerated one discovery order that the Python loader rejected — but the fragility was latent in all ports (a single-file projection-declared-before-its-base repro fails identically everywhere). Each loader now **stable-partitions overlay-only sources/roots to merge last**, deterministically, so base declarations are always present before any overlay re-opens them. Gated by a new shared cross-port conformance fixture (`projection-overlay-abstract-identity`, whose overlay basename deliberately sorts first) that all five ports serialize identically. (#160)

_npm `0.15.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates). NuGet unchanged at `0.15.4`, PyPI `0.15.6` (the Python-only #158 fix ships there), Maven Central unchanged at `7.7.3`. A TypeScript-only patch._

### Fixed
- **Offline `meta migrate` now threads consumer providers (#157).** `migrate baseline` and the offline `migrate` generate path called `loadMemory` without the `providers` from `metaobjects.config.ts` — so a project registering a custom subtype via a config provider hit `Unknown type` on offline migration, even though `meta gen` and the DB migrate paths loaded the same metadata fine. Both offline functions now load the config once up front and pass its providers to the loader (mirroring the DB path), and the offline generate path folds the later `columnNamingStrategy` read into that same load.

## [0.15.4] — 2026-07-03

_npm `0.15.4` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates) · NuGet `0.15.4` · PyPI `0.15.5` (Python stays a patch ahead) · Maven Central unchanged at `7.7.3` (the Java loader was already correct). A coordinated loader bug-fix patch._

### Fixed
- **Loader — root-level same-name nodes in different packages were wrongly merged (TS/C#/Python).** Two files declaring the same (type, name) at root level under different packages collapsed into one node: identical twins merged silently, and twins differing in an `@attr` (e.g. each package's `@objectRef` pointing at its own nested view) failed the load with `ERR_MERGE_CONFLICT`. Root-level merge matching now compares the package-qualified identity (own `package` else the file-default package) — mirroring the Java parser, which was already correct. Nested children stay bare-name matched; same-package cross-file overlay merging unchanged. New cross-port conformance fixture `loader-same-name-distinct-packages` (Java passes it unchanged). (#155)

## [0.15.3] — 2026-07-03

_npm `0.15.3` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

_npm `0.15.3` · NuGet `0.15.3` · Maven Central `7.7.3` · PyPI `0.15.4` (Python stays a patch ahead). A coordinated feature patch._

### Added
- **`@via` can traverse an `identity.reference` (reference-only FK).** A projection's `origin.*` `@via` join path may now name an `identity.reference` as a to-one forward-FK hop (target = `@references`, cardinality `one`), not just a `relationship.*`. The reference IS the FK — `findReferenceBetween` already derives every hop's join key from it, and a correlated relationship only adds a name + cardinality — so a FK-only / reverse-engineered model navigates it directly instead of authoring a redundant `relationship.association` that just restates the target. Valid in a `passthrough`, rejected in an `aggregate`; single-hop-unique inference stays relationship-only. Applied across all four loader ports (TS also updates the codegen join-tree; Python/Java/C# are loader-only) + a shared cross-port conformance fixture (`origin-via-reference-hop`) all four loaders serialize identically. (#153)

## [0.15.2] — 2026-07-02

_npm `0.15.2` · NuGet `0.15.2` · Maven Central `7.7.2` · PyPI `0.15.3` (Python was a patch ahead). A coordinated bug-fix + hardening patch._

### Fixed
- **codegen-ts — `isArray` field with a `@default` emitted invalid Drizzle** (`.array().default("<string>")` → `tsc` TS2345). A regression from the `0.15.0` `@dbColumnType` slim (arrays became native `text[]`); the default-emitter now parses the string default into a JS array literal (`.default([])` / `.default(["a","b"])`, `sql\`...\`` fallback), so array-default output typechecks. Adds a real-`tsc` compile-guard fixture. (#146)
- **Filter `in`-list size cap unified cross-port.** Java/Python/C# generated filter parsers + the Kotlin controller now enforce the same 100-element cap TS had — a `>100`-element `in` list is rejected with HTTP 400 (`filter.in_too_large`) so it can't be forced against the DB. Gated by a new shared api-contract conformance scenario. (#150, #32)
- **Java — `ERR_PROVIDER_ATTR_CONFLICT` is now actually thrown** with that code on a colliding attr child requirement (previously a bare `IllegalArgumentException`). (#148)

### Added
- **Provider-composition conformance harness** — five registry/provider error codes (`ERR_PROVIDER_DUPLICATE_ID` / `_MISSING_DEPENDENCY` / `_DEPENDENCY_CYCLE` / `_ATTR_CONFLICT`, `ERR_REGISTRY_SEALED`) are now gated cross-port (all 5 ports) via a shared named-provider manifest corpus. (#148, #33)

### Performance
- **Java read-path cache** wired into the resolving accessors (`getChildren`/`getMetaAttrs`/`isArrayType`), frozen-only + behavior-neutral — matching the existing TS/Python/C# caches — plus a 100k-object throughput benchmark gate. (#149, FR-031)

### Docs
- **Cross-language version-drift guidance.** Because the package-version lines differ by ecosystem (npm/PyPI/NuGet `0.x` vs Maven `7.x`), a stale port is invisible in the numbers; the `metaobjects-audit` skill now enumerates every port and compares the shared `metamodelVersion`, and the always-on prompt tells agents to keep all ports on the same Metamodel version. (#147)
- Documented the TS-only filter extensions (`search` / `filter[or]|[and]` / leading-wildcard / nesting) as not part of the cross-port contract. (#32)


## [0.15.2] — 2026-07-02

_PyPI `0.15.2` — Python-only patch (npm/NuGet stay `0.15.1`, Maven Central stays `7.7.1`)._

### Fixed
- **Python — the output-prompt spec emitter crashed `gen` / `verify --codegen` on a nested `field.object` payload.** A `template.output` whose payload value-object had a nested `field.object` child emitted invalid Python: the nested-object branch appended an inline `#` comment to the `PromptField` literal, and since the whole `OutputFormatSpec(...)` is one line, the `#` swallowed the closing `])` — an unterminated list (`SyntaxError`) that hard-crashed codegen and the drift gate (not just a diff). Flat payloads were unaffected. Python-only (the other four ports use inline-safe `/* */` block comments). The nested field now emits a valid `FieldKind.OBJECT` placeholder (`nested=None`).

## [0.15.1] — 2026-07-01

_Maven Central `7.7.1` · PyPI `0.15.1` · NuGet `0.15.1` · npm `0.15.1`._

> ⚠️ **This "patch" carries a BREAKING metamodel change** (versioned as a patch by request; treat it as breaking). Read the migration guide before upgrading: [`docs/features/migrations/identity-secondary-to-index-lookup.md`](docs/features/migrations/identity-secondary-to-index-lookup.md).

### Changed
- **BREAKING — `identity.secondary` is now a *unique* alternate key; `@unique` is removed** (ADR-0040). Uniqueness is encoded by the type, not a boolean — a legacy `@unique` on `identity.secondary` now fails load with `ERR_UNKNOWN_ATTR`.

### Added
- **New `index` type / `index.lookup` subtype — a *non-unique* retrieval index.** This is where a non-unique index now lives (previously mis-modeled as `identity.secondary @unique:false`). `@fields` is required (single or composite). The physical RDB escapes `@using` / `@expr` / `@where` / `@orders` are contributed by the db provider to both `index.lookup` and `identity.secondary`, consumed only by RDB codegen. `index.fulltext` / `index.vector` / `index.spatial` are reserved on the axis but not registered. Cross-port conformance-gated (registry, metadata, persistence). An `index.lookup` produces the same `CREATE INDEX` a non-unique index always did — **no schema/DDL churn** for the migrated form (a `verify`/migrate no-op).

### Migration
- `identity.secondary` with `unique: false` → **`index.lookup`** (drop `unique`, keep `name`/`fields`/any physical escape). `identity.secondary` with `unique: true` or absent → stays `identity.secondary`, drop the now-invalid `unique`. See the migration guide above.

## [0.15.0] — 2026-07-01

_Coordinated minor with breaking changes — Maven Central `7.7.0` · PyPI `0.15.0` · NuGet `0.15.0`
· npm `0.15.0` (follows via RC). The metamodel-1.0 vocabulary program plus the ADR-0039
own-accessor correctness fix, cross-port conformance-gated across all five ports._

### Added
- **1.0 metamodel vocabulary program (ADR-0036/0037/0038).** `field.uri` (native URI, text
  column) and `field.inet` (native IP, Postgres `inet` column) field subtypes; a `@stringFormat`
  attribute (`{email, hostname}`) for validated-string content; reverse navigation via generated
  explicit FK finders (`find<Source>By<FkField>(id)` + batched `…In(ids)`) instead of lazy
  collections; a closed-value-set conformance gate (`allowedValues` in the registry manifest). A
  general decision framework (ADR-0037) now governs when a new concept becomes a subtype vs `@kind`
  vs an attribute.

### Changed
- **BREAKING — `field.timestamp` is instant-by-default** (`timestamptz` / `Instant` /
  `DateTimeOffset` / aware `datetime`), with a boolean **`@localTime`** naive opt-out. Retires
  `@dbColumnType: timestamp_with_tz` (now derived from the subtype).
- **BREAKING — `@dbColumnType` slim-and-derive.** Array-ness is derived (`isArray`) rather than
  spelled as `uuid_array` / `text_array`, and the `text` default is derived; `@kind: text` and the
  `*_array` column types are dropped. `@dbColumnType` narrows to the genuinely-physical escapes
  (`uuid`, `jsonb`).

### Fixed
- **ADR-0039 — `own*()` accessors broke `extends` inheritance (all five ports).** `extends` is a
  super-reference, not a flatten: reading a field/node's effective property (`isArray`, `subType`,
  `@maxLength`, `@precision`, `@default`, `@objectRef`, `@storage`, …) or iterating its members via
  an own-only accessor silently dropped `extends`-inherited values, corrupting codegen and runtime.
  Resolving/effective accessors are now the default everywhere; `own*()` is reserved for its one
  legitimate use (codegen emitting a generated subclass's own members) plus the metamodel-internal
  serializer/overlay/`origin.*`/`@dbColumnType` cases. A concrete field or entity that `extends` an
  abstract parent now correctly inherits its properties and members, guarded permanently by a shared
  `extends-abstract-field-inheritance` conformance fixture. Notable bugs it surfaced: an entity
  inheriting its `source.rdb` via `extends` generated no table/controller; an M:N junction
  inheriting its `identity.reference` children was falsely rejected; a Python runtime path dropped
  an inherited M:N relationship.

## [0.14.2] — 2026-06-29

_npm `0.14.2` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — required jsonb open-bag generated an uncompilable `z.unknown().min(1)`.**
  The 0.14.0 jsonb open-bag change (`field.string` + `@dbColumnType: jsonb` → `z.unknown()`)
  left the string character-count validators attached: a **required** jsonb field still got
  the required-non-empty `.min(1)` chained onto its `z.unknown()` base, emitting
  `z.unknown().min(1)` — a TS compile error (`ZodUnknown` has no `.min`). The validator
  chain now skips the string `.min`/`.max`/`.regex` for a jsonb open bag (a jsonb array
  still gets element-count bounds); "required" for an open bag means non-optional only.
  Surfaced by an adopter whose generated schema stopped compiling after 0.14.0.

## [0.14.1] — 2026-06-29

_npm `0.14.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — package-qualified relationship `@objectRef` dropped projection
  joins.** When a projection's aggregate traversed a relationship whose `@objectRef`
  was package-qualified (`pkg::Entity`) — the shape the directory loader produces for
  a same-package objectRef even when authored bare — the join resolver looked the
  target up by the raw qualified name while `findObject` keys on the bare name, so the
  join silently failed to resolve and **every aggregate traversing it was dropped**:
  the view degraded to PK + passthrough columns only. `extract-view-spec` now
  `stripPackage`s the `@objectRef` before `findObject`, matching the `@via` / `@of` /
  `@from` paths. Surfaced by a directory-loaded consumer whose `count`/filtered-`max`
  aggregate columns vanished from a generated view while the string-loaded test fixture
  (bare objectRef) passed.

## [0.14.0] — 2026-06-29

_npm / PyPI / NuGet `0.14.0` · Maven Central `7.6.0`. A coordinated **minor** with
breaking changes (verify strict-by-default + the jsonb open-bag contract)._

### Changed
- **BREAKING — `verify` is strict-by-default across all CLI ports (ADR-0023).** An
  undeclared or typo'd own `@attr` is now `ERR_UNKNOWN_ATTR` and the gate exits
  non-zero. This closes a real cross-port hole: the original assumption was "Java
  enforces strict, TS/Python are lax", but Java was in fact **not enforcing either**
  — its loader *records* `ERR_UNKNOWN_ATTR` (record-not-throw) and the Maven mojo
  never drained `getErrors()`, so `metaobjects:generate`/`:verify` silently passed.
  All four CLI ports now genuinely enforce strict and ship an escape:
  - **TS** `meta verify` + **Python** `metaobjects verify` → `--lax` (#101)
  - **C#** `dotnet meta verify` → `--lax` (#107)
  - **Java/Kotlin** Maven goals → `-Dmeta.lax=true`, and the goals now **fail the
    build on a recorded loader error** instead of silently passing (#108)

  **Scope:** only `verify` defaults strict on the Node/C# CLIs (`gen`/`docs`/`agent-docs`
  stay lax); the Java goals gate at generate-time too. **Migration:** if the gate now
  flags an attr you rely on, register it on a metadata provider, move arbitrary
  author-supplied properties into an `attr.properties` bag, or pass `--lax` /
  `-Dmeta.lax=true`. The failure message names all three exits. (#96)
- **CHANGED — a jsonb open-bag is now a parsed JSON value at the API boundary
  (all five ports).** A `field.string` + `@dbColumnType: jsonb` (the sanctioned
  untyped-JSON escape hatch) was generated as a *string* in the validator/DTO while
  the column returns a parsed object — so a client could not POST/receive a real JSON
  object (it had to double-encode). Now the generated contract types it as a JSON
  value, wire form unchanged: TS `z.unknown()` (#97), Python `Any` (#99), Java
  `Object` (#103), Kotlin `kotlinx JsonElement` at every layer (#104), C#
  `System.Text.Json.JsonDocument` (#105). Adopters who hand-handled the field as a
  raw string may need to adjust. (#98)

### Added
- **codegen-ts-react — nested value-object sub-forms in `formFile`.** A
  `field.object` with an `@objectRef` to a value object now renders as a nested
  `<fieldset>` sub-form (react-hook-form nested paths; arrays via `useFieldArray`)
  instead of a single text `<input>` bound to a JSON object. Recurses one+ levels
  with cycle/depth guards. (#95)

### Fixed
- **sdk — Meta Forge descriptive layer is now strict-clean.** `loadMemory` bundles
  the Meta Forge descriptive types (`decision`/`principle`/…) and their `@forge*`
  provenance attrs so mixed prescriptive+descriptive content loads. Under the new
  strict `verify`, those were rejected (`ERR_CHILD_NOT_ALLOWED` / `ERR_UNKNOWN_ATTR`);
  the forge provider now admits its types under `metadata.root` and registers the
  `@forge*` attrs as common attrs, so a real memory record verifies clean. (#96)

## [0.13.1] — 2026-06-28

_npm `0.13.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — `origin.aggregate` `@filter` in projection view DDL.** A scoped
  aggregate (e.g. `max(version) where status='active'`) declared via the aggregate's
  optional `@filter` generated into the TS contract but was dropped from the generated
  `CREATE VIEW` — the emitter rendered the aggregate with no `FILTER` clause, so it
  computed over all related rows. `extract-view-spec` now reads + desugars the filter
  and `view-ddl-emit` renders postgres `AGG(src) FILTER (WHERE …)` (and the portable
  `AGG(CASE WHEN … THEN src END)` form on sqlite). (#90)

## [0.13.0] — 2026-06-28

### Added
- **codegen-ts — declarative Mustache template-codegen (SP-1a):** a
  `templateGenerator` can now take its walk **declaratively** via `scope`
  (`"perEntity" | "perPackage" | "perModel"`) + `outputPattern` instead of a
  hand-written `walk` (the two are mutually exclusive — provide exactly one). The
  generator derives a **neutral, structural** template data dict per unit
  (`buildEntityTemplateData` / `buildPackageTemplateData` / `buildModelTemplateData`,
  with types `FieldTemplateData` / `EntityTemplateData` / `IdentityTemplateData` /
  `RelationshipTemplateData` / `PackageTemplateData` / `ModelTemplateData`) — raw
  structural facts only, distinct from the Markdown-flavored `EntityDocData`, and
  byte-gated as a cross-port contract by `fixtures/template-codegen-conformance/`.
  `outputPattern` supports `{name}` / `{Name}` / `{package}` (`::` → `/`; unknown
  placeholder throws), expandable via the exported `expandOutputPattern`. A JSON
  **template-spec** (`parseTemplateSpec` / `templateSpecToGenerators`, types
  `TemplateSpecEntry` / `TemplateSpecFile`, JSON Schema beside the source) is the
  surface the C#/Python CLI ports will reuse. New package-scope engine helper
  `perPackage(fn)` joins `perEntity` / `perModel`. All exported from the package
  main entry `@metaobjectsdev/codegen-ts`.
- **cli — `meta init` scaffolds owned codegen generators (ADR-0034 scaffold-and-own, step 2):**
  `meta init` now copies the four codegen reference templates (step 1) into the
  consumer repo at `codegen/generators/{entity,queries,routes,barrel}.ts` and
  scaffolds `metaobjects.config.ts` to import those **local** copies, so `meta gen`
  runs from generators the consumer owns and edits — not from the package. Each
  generator is written only if absent, so re-running `meta init --force` never
  clobbers a hand-edited generator (mirrors the existing config.ts preservation).
  codegen-ts gains a small reference-template reader the CLI uses to read the
  shipped assets (`resolveReferenceRoot` / `readReferenceTemplate` /
  `REFERENCE_GENERATOR_NAMES`, exported from `@metaobjectsdev/codegen-ts`).
- **codegen-ts — reference template library (ADR-0034 scaffold-and-own, step 1):**
  new in-repo, copyable reference generators under `src/reference/`
  (`entity` / `queries` / `routes` / `barrel`) — self-contained starting points a
  consumer copies into their repo and owns, importing only the public engine
  (`@metaobjectsdev/codegen-ts`) plus `ts-poet` and `@metaobjectsdev/metadata`.
  Each carries a `use-when / emits / customize / composes-with` header. Purely
  additive — no existing generator or export was removed; the templates are
  scaffold assets excluded from the package build. To keep a copied generator on
  public imports only, the engine now also re-exports the assembly helpers those
  templates use: `renderTphDiscriminatorUnion`, `hasWritableRdbSource`,
  `renderSharedEnumsFile` / `SHARED_ENUMS_BASENAME`, and the queries CRUD-block
  renderers (`renderFindByIdFn`, `renderListFn`, `renderCreateFn`,
  `renderUpdateFn`, `renderDeleteByIdFn`, `getPkInfo`). (`meta init` scaffolding,
  generator-export deprecation, and the guidance rewrite are later steps.)

### Deprecated
- **codegen-ts — `oncePerRun` scope helper (SP-1a):** renamed to `perModel` —
  "run" is ambiguous under multi-target output (it reads as "per target"), while
  `perModel` names the data scope (the whole model). `oncePerRun` is kept as a
  soft-deprecated alias and still works.
- **codegen-ts — `@metaobjectsdev/codegen-ts/generators` factory re-exports
  (ADR-0034 scaffold-and-own, step 2):** importing `entityFile` / `queriesFile` /
  `routesFile` / `barrel` from the package `/generators` export is deprecated in
  favor of the owned local copies `meta init` scaffolds. The export still works
  (pre-GA latitude) but will be removed in a future major — own a copy instead.

### Fixed
- **cli — `meta init` gitignore hardening:** the scaffolded
  `.metaobjects/.gitignore` previously ignored only `.gen-state/`, so a
  multi-target codegen config routing a target's `outDir` under
  `.metaobjects/<target>/src/generated/` let that regenerable generated shadow
  get committed by default. The scaffold now also ignores `*/src/generated/` and
  re-includes the tracked artifacts (`!migrations/`, `!config.json`,
  `!package.meta.json`) so they can never be swept up.
- **cli — `meta init` monorepo-subdir warning:** scaffolding the agent-context
  `.claude/skills/` into a git subdirectory means a repo-root-launched Claude
  session won't discover the skills (discovery walks cwd + ancestors, never down
  into subdirs). `meta init` now warns when run inside a subdir of a git repo and
  points at `cd <repo-root> && meta init --docs-only --server <lang>`. Scaffold
  warnings are also now surfaced on the normal init output path (previously
  dropped).

## [0.12.5] — 2026-06-27

_npm `0.12.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — projection read-type nullability** now mirrors the view column:
  a non-`@required` projection field generates a nullable Drizzle view column but
  previously kept a non-null Zod read type, so the generated projection query
  returned `T | null` into a non-null `<Name>` field and failed to compile under
  strict TS. The read field is now emitted as `.nullable()` whenever its view
  column is not `.notNull()`, so the read type matches the view's SELECT type.

## [0.12.4] — 2026-06-27

_npm `0.12.4` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — projection codegen:** an `object.projection` (read-only,
  view-backed) now generates **read-only** query helpers (`find…ById` + `list…`
  selecting from the view) instead of table-style create/update that imported a
  nonexistent `<Name>InsertSchema`. This fixes a `TS2724` compile error that made a
  declared projection fail to build, forcing consumers to revert to hand-rolled
  aggregates. (Mirrors the `isProjection` guard the routes generator already had.)
- **codegen-ts — generated SQLite `Db` type** is now
  `BaseSQLiteDatabase<"sync" | "async", unknown>`, accepting **both** sync
  (`better-sqlite3`, the most common driver) and async (libsql/Turso/D1) Drizzle
  databases. The previous `<"async">` pin rejected `better-sqlite3` with
  "is not assignable", forcing `db: any` casts.
- **codegen-ts — generated Postgres `Db` type** is now the base
  `PgDatabase<PgQueryResultHKT, …>` that every PG driver extends (node-postgres,
  postgres.js, Neon, Vercel, pglite), not just `NodePgDatabase`.

### Added
- **cli — verify-as-teacher:** `meta verify` and `meta gen` run an **advisory**
  pass that flags hand-rolled aggregates, money-as-float, and `CHECK (… IN …)`
  enums and names the construct that models them. Warnings only — never changes the
  exit code. Opt out with `--no-antipatterns` or `META_NO_ANTIPATTERNS=1` (both
  honored on both commands).
- **agent-context skills:** a model-first / generate-first operating principle in
  the authoring skill, and a first-class "write your own generators" section in the
  codegen skill (with the accurate `Generator` / `perEntity` API).

## [0.12.3] — 2026-06-26

_npm `0.12.3` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Agent-context: granular codegen control + projection consumption + the runtime→Fastify
  mount API.** The `metaobjects-codegen` skill now teaches that codegen is à la carte (omit
  `routesFile()` to generate the data layer + hand-write the routes, mix generated and
  hand-written, declare an `object.projection` *and consume its generated query*, copy/extend
  generators); the `metaobjects-runtime-ui` (TypeScript) reference documents the real
  `@metaobjectsdev/runtime-ts/drizzle-fastify` mount helpers (`mountCrudRoutes({ expose })`,
  `mount<Verb>Route`, `mountReadOnlyCrudRoutes`) so agents stop reverse-engineering
  `node_modules` (#78).

## [0.12.2] — 2026-06-25

_npm `0.12.2` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **Drizzle codegen annotates every FK `.references()` callback with `(): Any{Pg,SQLite}Column`.**
  Cross-module circular references (table A → B while B → A) went through the un-annotated
  branch and failed `tsc --strict` with TS7022; `codegen-ts` now emits the explicit return
  type unconditionally (Drizzle's documented fix for circular inference) (#76).

## [0.12.1] — 2026-06-25

_npm `0.12.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta types` vocabulary search + `whenToUse` decisional guidance.** A new
  `meta types [query]` command — apropos + `kubectl explain` over the live registry
  (`--desc`/`--all` description search, `--kind`/`--type` filters, terse/`--detail`/`--json`
  output) — plus the canonical `whenToUse` "reach for this when…" guidance on the data-modeling
  constructs in `spec/metamodel/*.json` (flows to all five ports), so an agent finds and uses
  the right metadata construct instead of hand-writing data logic (#74).

## [0.12.0] — 2026-06-25

_npm `0.12.0` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Agent-friendly `meta` CLI.** A `--format` flag with TOON output (a compact,
  machine-readable format that becomes the default when stdout is piped to an
  agent/CI), structured errors and next-step hints emitted on stdout, package-manager
  detection, and deploy-all agent-context reference fragments (#71).

### Fixed
- **`meta init` agent-context scaffold no longer guesses the migration binding.**
  The injected `AGENTS.md`/`CLAUDE.md` now name the database schema **and migrations**
  as metadata-derived in the "never hand-write" principle ("change the metadata and
  regenerate, never hand-write SQL"), and the stack line dropped the guessed
  "migrations are TS" clause. This prevents an AI agent from hand-writing a raw
  `ALTER TABLE` against a generated schema and silently reintroducing the drift
  `meta verify` exists to catch. The verify skill's JVM startup-validator note was
  also hedged to an opt-in (#1, #73).

## [0.11.6] — 2026-06-24

_npm `0.11.6` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Typed projection (view-kind) read models.** A projection's Drizzle `.existing()`
  view declaration now emits a typed column map (honoring `@dbColumnType`, e.g.
  jsonb/timestamp) instead of an empty `{}`, so `db.select().from(view)` is typed.
- **Projection passthroughs resolve value-object refs** — a `field.object` passthrough
  carries the value object's Zod schema + `.$type<VO>()` into the read schema/type, so
  the row is typed as the VO rather than `unknown`.
- **`runtime` flag on output targets** (`TargetConfig.runtime`, default `true`). A
  contract-only target (`runtime: false`) emits Zod schemas + inferred TS types and
  nothing else — no `drizzle-orm` (table or view) and no `runtime-ts` allowlists — so a
  shared wire-contract package consumed by a UI client carries no DB dependency. The
  axis is the target's audience (server vs contract), applied uniformly to entities,
  value objects, and projections.

### Changed
- Replaced the short-lived per-artifact `includeViewDecl` generator option with the
  target-level `runtime` flag above. `allowlists` remains as the finer Fastify-vs-Hono
  opt-out within a runtime target.

## [0.11.5] — 2026-06-22

_npm `0.11.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Changed
- **All view DDL is unified onto one emitter + the single schema-diff path.** The
  parallel `computeProjectionMigrations` / `source-aware-diff` view-migration stack
  is deleted; `emitViewDdl` (via `buildProjectionViews`) is now the sole producer of
  every `CREATE VIEW`, and the schema-diff produces all view changes (create / drop /
  replace) including a dependency-recreate pass that drops + recreates a view around
  a column-altering change to a table it reads.
- **Aggregate views now render as `LEFT JOIN + GROUP BY`** (with `COUNT(DISTINCT …)`)
  instead of correlated subqueries. The two are data-equivalent for a single
  has-many join — pinned by the `projection-aggregate` persistence-conformance
  scenarios (populated rows + the empty-parent `NULL` case).

### Fixed
- **View JOIN columns now honor the column-naming strategy + `@column`** instead of a
  hardcoded `snake_case` guess, and **view-body identifiers are quoted when needed**,
  so `literal` / `kebab-case` columns (e.g. `programId`) survive Postgres
  case-folding.
- **SQLite/D1 view migrations** are now emitted (previously Postgres-only); `drop-view`
  is staged before the recreate-and-copy so a dependent view can't error mid-recreate.
  `introspectD1` now reads view bodies, so D1 detects view-body drift.

### Removed
- migrate-ts barrel exports for the deleted view-diff stack
  (`classifyViewDiff`, `computeViewMigrations`, `emitPostgresViewMigration`,
  `emitSqliteViewMigration`, and the `ViewShape` / `ViewDiffClass` / `ViewMigrationOpts`
  / `ViewMigration*` types).

_(0.11.3 was deprecated as a broken isolated patch; 0.11.4 — full lockstep view-DDL
fix + native SQL array columns — shipped without a changelog entry.)_

## [0.11.2] — 2026-06-22

_npm `cli` + `migrate-ts` `0.11.2` (isolated patch; other packages stay `0.11.1`)._

### Fixed
- **`field.map` columns now generate a `jsonb` DDL type** (was defaulting to `TEXT`). `field.map` was added to the metamodel and `codegen-ts` (emitting `jsonb` + `Record<string,V>`), but `migrate-ts`'s expected-schema column-type switch had no case for it, so generated migrations set the column to `TEXT` while the ORM layer expected `jsonb`. `cli` repins to the fixed `migrate-ts`.

## [0.11.1] — 2026-06-22

_npm `0.11.1` · NuGet `0.11.1` · PyPI `0.11.1` · Maven Central `7.4.1`._

### Added
- **`field.map` subtype** — an open-keyed map (`Record<string,V>` / `dict[str,V]` / `Map<String,V>` / `IDictionary<string,V>`) stored in a single `jsonb` column. Keys are always strings; the value type is set by exactly one of `@valueType` (a scalar field subtype) or `@objectRef` (a value-object). Implemented across all five ports with cross-port registry-conformance and a loader rule enforcing the exactly-one-of value spec.

## [0.11.0] — 2026-06-21

_npm `0.11.0` · NuGet `0.11.0` · PyPI `0.11.0` · Maven Central `7.4.0`._

### Added
- **Semantic cross-field validators** — `validator.comparison` / `requiredWhen` / `presentIff` / `atLeastOne`: entity-scoped rules that reference sibling fields by name (a field compared to another, a field required when another equals a value, two fields mutually present/absent, at-least-one-of a set must be present).
- **Expression / functional indexes** — `identity.secondary` now carries `@expr` (a functional index expression, e.g. `lower(email)`) and `@using` (the index method), plus physical index/constraint attributes, auto schema-scope, and DB-adoption fixes for migrations.
- **Metadata reference enforcement** — a dangling cross-reference now fails the load instead of being silently ignored: an unresolved `relationship.@objectRef` raises `ERR_INVALID_RELATIONSHIP` and an unresolved `identity.reference.@references` raises `ERR_INVALID_REFERENCE`, with a source envelope pinpointing the node (catches metadata drift immediately).
- **Validation derived from the type registry** — each type's registration carries its cross-reference descriptors (and an optional validator), enforced by one registry-driven walk, so a downstream provider's new type validates itself with no core changes. (The config-driven, write-once-across-ports evolution is tracked in #51.)
- **A load reports every validation error, not just the first** — passes collect findings (deduped by code + source) and surface them together rather than aborting on the first.
- **jsonb value-object typing (TS codegen)** — typed jsonb VO columns, collection-name control, and a shared VO module resolver.
- **`buildGrid()`** in `@metaobjectsdev/runtime-web` — metadata-driven grid columns at runtime.
- **C# entity inheritance codegen** — TPH abstract intermediates + direct-parent chain (`DirectMappedParent`) + `@required` CLR nullability, and the non-TPH inheritance chain.

### Changed
- **BREAKING — dangling metadata references now fail to load.** Models that referenced a non-existent entity via `@objectRef` / `@references` previously loaded silently; they now error (`ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_REFERENCE`). Fix the reference or remove the relationship/identity.
- **Config-driven default name for a name-less singleton `identity.primary`** — a name-less primary now loads named `"primary"` (referenceable as `Entity.primary`); a second primary on one entity is `ERR_TOO_MANY_OCCURRENCES`.

### Fixed
- **Inherited attributes now resolve via the effective accessor across all ports** — codegen + validation were reading some attributes own-only, so a field/identity that inherited `@required` / `@maxLength` / `@objectRef` / `@fields` via `extends` (the BaseEntity / abstract-field pattern) was silently mis-generated: wrong column nullability (an inherited `@required` field emitted as optional), wrong `varchar` length, a dropped FK, or a dropped primary key. Now correct in TS / Java / C# / Python / Kotlin, with cross-port regression gates.
- **Self-referential foreign keys** — a FK whose target is the same entity (`parentId`, `managerId`) is now emitted without a circular self-import (TS/Drizzle `AnyPgColumn`/`AnySQLiteColumn`) and round-trips through every port's runtime (gated by a new persistence-conformance scenario).
- **Cross-package FK resolution** — a FK to a target in another package now resolves its target PK column correctly in the expected schema.
- **Kotlin codegen** — FK to a non-`id` PK, reserved Exposed member names, PK-first column order, and cross-package `Table` object imports.

### Cross-port
- The above ship across the relevant ports (TS / Java / C# / Python / Kotlin), gated by the shared conformance corpora.
- Released as npm `0.11.0` · NuGet `0.11.0` · PyPI `0.11.0` · Maven Central `7.4.0`.

## [0.10.0] — 2026-06-14

### Added
- **FR-033 metamodel self-description + `meta docs` metamodel pages** — every metadata type/subtype/attribute now carries declarative descriptions and per-subtype constraints (authored once in `spec/metamodel/*.json`, embedded per port), and the neutral docs engine renders tiered metamodel reference pages (index one-liners + per-provider detail) wired into the authoring skill.
- **FR-024 `object.projection` taxonomy** — new first-class `object.projection` subtype for derived read-only models, universal deep dotted `Entity.child` extends (e.g. `Customer.priceCents.display`), `@via` inference for single-hop relationships, and value-object purity rules (ADR-0028/ADR-0029).
- **FR-017 polymorphic (TPH) codegen across the TS stack** — discriminated-union entity types + per-subtype Zod schemas, Drizzle single-table emission, polymorphic + per-subtype REST routes, TanStack hooks/grid, React forms, and per-subtype filter/sort allowlists for table-per-hierarchy inheritance.
- **FR-018 M:N relationships** — slim `@through` / `@sourceRefField` / `@symmetric` vocabulary (FK fields derived from the junction's `identity.reference`), Drizzle m2m codegen, REST traversal `GET /<source-plural>/{id}/<relation>`, and a typed TanStack collection hook `use<Source><Relation>`.
- **FR-019 shared & `@provided` enums** — reuse enum types across entities and bind a `@provided` enum to its declaring package; `@provided` is now first-class cross-port vocabulary.
- **`@metaobjectsdev/ai-runtime` package + AI LLM-call trace persistence** — typed `record<Entity>`/`call<Entity>` trace helpers, `callLlm` bridge, pluggable cost catalog, `LlmClient` seam, and Composite/Langfuse/OTel recorders; `@responseRef` on `template.prompt` and `template.*` children under `object.entity` are now supported vocabulary.
- **Unified `meta docs` door (ADR-0025)** — one command and one `docs:` config block emit both the model surface (entity + template pages) and the SDK/API reference surface (`docs/api/`, including `AGENT-API.md`), cross-linked; supports per-language `apiSurfaces` for polyglot solutions.
- **SDK/API reference docs (api-docs)** — runnable examples, per-symbol import paths, surfaced throws, and field shapes for model/create/update/REST/extractor payloads; covers relations, callable, prompt-render, and Hono.
- **Linked, syntax-highlighted template source on template pages** — fenced highlighted block + a Variables→field link table + a rich inline-linked HTML view, with per-field anchors and a link-integrity gate reusing `verify()`'s variable→field resolver.
- **Neutral entity-doc improvements** — per-entity 1-hop neighborhood mini-diagram (clickable, classed, value-object nodes), and a merged single Fields table (Storage + Constraints).
- **`@embeddedColumnPrefix`** for flattened owned-type columns, and `@summary` common documentation attribute.
- **Agent-context staleness nudge** — `meta gen`/`verify` prompt to refresh adopter agent-context when it predates the installed CLI.

### Changed
- **BREAKING — FR-026 / ADR-0032: canonical refs are now fully-qualified.** Relative ref navigation (`bare`, `::root`, `..::parent`) is YAML-authoring-only; canonical JSON must carry absolute `package::Name` refs. A relative ref in canonical JSON is rejected with `ERR_RELATIVE_REF_IN_CANONICAL`.
- **BREAKING — FR-024 hard cutover.** The pre-FR-024 spellings are gone: an `object.entity` whose primary source has a read-only `@kind` (`view`/`materializedView`/`storedProc`/`tableFunction`) is now `ERR_ENTITY_PRIMARY_SOURCE_READONLY` — derived read models must be `object.projection`. Identity nodes now require a name.
- **BREAKING — strict per-subtype attribute placement.** The loader rejects subtype-specific template attributes declared on the wrong subtype.
- **BREAKING — `apiDocsFile()` demoted from a `meta gen` generator** to the `meta docs` API-surface engine; it is deprecated for `meta gen` (the runner warns and skips it) and dropped from the `meta init` scaffold in favor of a `docs:` block.
- **`meta init` scaffold default `outDir` is now `src/generated`** (was `./src/db`); api-docs is on by default in the scaffold.
- **`@objectRef` resolves to a bare class name** in generated code, using `resolution_key` for the header FQN.
- **`@metaobjectsdev/ai-runtime` descoped (ADR-0024)** — bundled vendor LLM clients and the built-in cost rate table were removed; bring your own LLM caller library (the `CostFn`/`LlmClient` seams remain).

### Fixed
- **`verify --templates` resolves `@payloadRef` by FQN short-segment.**
- **`extract` maps a JSON `null` literal to an actual null** (not the string `"null"`) and inherits enum-coercion attrs through `extends`.
- **Doc generation no longer silently overwrites pages** on cross-package short-name collisions (hard-errors, with package-layout support); `meta docs` honors project `outputLayout` and surfaces a broken `metaobjects.config.ts` instead of swallowing it.
- **Browser-safety fix** — node-only registry-coverage re-exports removed from the browser-facing barrel.
- **Repaired the workspace typecheck gate** (cleared pre-existing `tsc` errors) and added a pre-push typecheck gate to block type-broken pushes.

### Cross-port
- The above metamodel, codegen, and docs features were fanned out across the Java/C#/Python/Kotlin ports (FR-017 TPH runtime + codegen, FR-018 M:N resolvers, FR-019/FR-024/FR-026/FR-033, AI trace recorders, native SDK/API-reference docs, and `agent-docs` goals/commands), all gated by the shared conformance corpora.
- Released alongside NuGet `0.10.0` and Maven Central `7.3.0`.

## [0.9.0] — 2026-06-01

### Added
- **`migrate-ts` reference-snapshot engine** — schema migrations now diff against a committed, per-dialect `SchemaSnapshot` (offline, deterministic) instead of a live DB: offline snapshot planner, metadata baseline, deterministic snapshot serializer with `formatVersion` 2, and `snapshotChecksum`/`verifyReplay` integrity APIs exported from the package.
- **Migration runner** — transactional `applyPending`, `rollbackTo` (reverse-order down), append-only timestamped migrations on disk, `PgExecutor`/`PgHistoryStore` with configurable schema/table (multi-tenant), Postgres session advisory lock, content-normalized checksums, and a `_metaobjects_migrations` ledger with baseline marker.
- **CLI migration + verify commands** — `meta migrate --apply` (postgres/sqlite, ledger-backed), `meta migrate --rollback`, `meta verify --db` schema-drift gate (exit 1 on drift; DB-free default unchanged), `meta migrate baseline` (`--from-metadata` / `--from-db`), and default offline snapshot generation.
- **CHECK constraint codegen** — `migrate-ts` derives CHECK constraints from `field.enum @values`, `validator.numeric @min/@max`, `validator.length @min`, and `validator.regex @pattern` (Postgres), with add-check/drop-check change kinds, restore-on-drop, and PG-rewrite-tolerant expression comparison.
- **Runtime object model** — `ValueObject` map-backed base, `MetaObjectAware` back-reference, self-registering `ObjectClassRegistry` (FQN→ctor), and a reflection-free `newInstance` factory in `@metaobjectsdev/metadata` (AOT-safe).
- **`extract` codegen + tolerant payload parsing** — generated `<Name>Extractor` parses LLM/wire output into a strict typed payload (nested objects + arrays), delegating to the runtime object model; payload fields are now value-constrained typed unions for `field.enum`.
- **`template.output` render helper** — per-`template.output` codegen emits `render<Name>(payload, provider)` for `@kind=document` and an `EmailDocument` (`@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) for `@kind=email`, with a build-time Mustache↔payload-VO drift gate that fails codegen on an unmatched `{{field}}`.
- **New metamodel vocabulary** — `field.uuid` logical subtype, `@dbColumnType` physical-column-type attribute, `field.decimal` (precision/scale), FR-013 field-level `@readOnly` (excluded from Insert/Update schemas), FR-014 TPH discriminator metadata, FR-015 `@parameterRef` + callable-wrapper codegen (storedProc / tableFunction), FR-016 `source.rdb` per-kind physical-name aliases, and FR-011 `@normalize`/`@coerceDefault` enum-coercion attrs on `field.enum`.
- **Nested-object prompt expansion** (FR-012) — `render()` expands nested objects and arrays in prompt templates.
- **Plain-Fastify mount** in `@metaobjectsdev/runtime-ts` reaches contract parity with the Drizzle-Fastify mount (`withCount`, `invalid_sort` → 400).

### Changed
- **Renamed `recover` → `extract` across the public surface** (`extractLenient` tier, `extract/` module) — generated `recover()` and the `recover-conformance` corpus are renamed accordingly; consumers calling the prior `recover` API must migrate to `extract`.
- **Runtime return types are now native in-process types** (ADR-0019) — `ObjectManager`/runtime queries return native types (`field.decimal` → string in TS) with wire canonicalization applied only at the serialization boundary, not inside the query path.
- `field.decimal` now maps to `string` with a fractional-ms read-path normalization in generated TS code.
- `@maxChars` over-budget now throws (previously truncated in some ports), aligning render behavior across all ports.
- `@readOnly` and `origin.*`-derived fields are excluded from generated `InsertSchema` / `UpdateSchema`.

### Fixed
- `migrate-ts` SQL handling: quote/comment/dollar-quote-aware statement splitter for hand-authored migrations, `normalizeCheckExpr` folds PG `= ANY(ARRAY[..])` back to `IN`, cast-strip preserves `::` in regex patterns, and CHECK constraints emit as inline create-time only (no duplicate/non-idempotent diff).
- `migrate-ts` runner: no client leak when advisory-lock acquire throws, correct `applied_at` cast, view-body change detection, and down-from-snapshot restores index/FK shape changes plus the table's own indexes/FKs.
- `validator.length @max` emits a length CHECK rather than a VARCHAR cap.
- Enum payload mirror-string is cast to the typed union under the strict mapper (tsc-strict clean); extractor scalar-array mapping and required-ness predicate corrected.
- `@default` on `field.enum` is validated against declared members, and per-type `@default` coercibility is validated at load (cross-port parity).

### Cross-port
- Java / C# / Python / Kotlin reached parity on the runtime object model, metadata-driven `extract`, `<Name>Extractor` codegen, `template.output` render helper, typed-enum payloads, and the FR-011/013/014/015/016 + SP-A decimal/temporal-fidelity work, all gated by shared conformance corpora.
- New cross-port conformance gates added: generated-API-over-HTTP fan-out for all five ports (SP-B/SP-F, found 10+ real deployment bugs), validator-parity corpus (SP-C), runtime return-type contract (SP-D), CLI parity (SP-E — `dotnet meta`, Python `metaobjects` console-script, Java `meta:verify`), and the R13 output-prompt-fragment corpus.

## [0.8.1] — 2026-05-30

### Added
- `codegen-ts`: standalone read-only view-entities — a projection can now map a view's columns directly without `extends`-ing a writable entity, enabling views over non-entity-backed tables and views that expose a deliberately narrowed/safe column set (join-backed view-DDL generation still requires `extends`; standalone views supply their own SQL).

### Cross-port
- OMDB (Java runtime) correctness fixes not affecting the npm packages: standard ANSI `OFFSET/FETCH` paging for MSSQL/Oracle, app-side UUID primary-key minting, atomic bulk-create fallback under caller-managed transactions, and read/write codec unification.

## [0.8.0] — 2026-05-30

### Added
- **FR-010 tolerant output parsing & prompt rendering** in `@metaobjectsdev/render` — a forgiving `recover()` engine (fence-stripping, root-span location, no-hang JSON/XML readers with truncated/unclosed-tag recovery, enum-alias and numeric-range coercion, returning `RecoveryResult`/`RecoverMap`) plus an `OutputFormatRenderer` emitting `guide`/`inline`/`exampleOnly` prompt fragments.
- **FR-010 codegen** in `@metaobjectsdev/codegen-ts` — per-`template.output` generators emit `<Template>.prompt.ts` with `render<Name>Format()` and a typed tolerant `recover()` alongside `parse()` for json/xml outputs.
- **FR-010 metamodel attributes** accepted by the loader: `@promptStyle`, `@example`, `@instruction`, `@enumAlias`, `@enumDoc`.
- **`emitAbstractShapes` config knob** (default `true`) on `MetaobjectsGenConfig` — when `false`, abstract entities emit no file at all (cross-port parity).

### Changed
- **Abstract entities never emit instantiable artifacts.** `@isAbstract` is now honored universally across codegen — abstract entities render shape-only (type-only interface + Zod, never a Drizzle table), and write-form, CRUD hooks, and filter allowlists are skipped for both abstracts and projections.
- **R6 float/double wire fidelity** — `field.float` now emits SQL `REAL` (single precision), distinct from `field.double` (`DOUBLE`); `migrate-ts` collapses `real4`→`real` for SQLite to avoid a phantom float diff, and both round-trip as wire-normalized strings.
- Cross-port: conformance parity advanced across all five ports (TS/Java/Kotlin/C#/Python) for FR-010 recover/render and R6 float, plus a Spring Boot 3 OMDB autoconfiguration starter on the JVM side.

### Fixed
- **`EntityGrid` (`@metaobjectsdev/tanstack`) accepts id-less projection rows** — relaxed the row-type bound from `{ id?: number | string }` to `object` so generated grids over composite-identity view models type-check.
- **Cross-package, cross-file `extends` resolution** — a concrete-first entity extending a base declared in a different file-default package (e.g. `acme::common::BaseTenantEntity`) no longer fails super-resolution after the merge into the shared root.
- **CLI `ParseError`s are no longer masked**, surfacing actionable loader errors to consumers.

## [0.7.0-rc.12] — 2026-05-28

### Changed
- **Three-way merge overwrite policy.** `decideAndWrite()` switched from
  marker-based (clobber if `@generated` is present, refuse otherwise — the
  rc.11-era strategy that silently lost hand-edits) to three-way merge
  against a canonical snapshot stored under `.metaobjects/.gen-state/`.
  Hand-edits in generated files now survive regen automatically (the spike
  002 "HARD" case); same-line edits surface as standard git-conflict
  markers (the "CONFLICT" case). The `@generated` marker becomes
  informational, no longer load-bearing.

  Restated in adopter terms:
  - **Easy case** (you add a comment): clean merge integrates it
  - **Hard case** (you tweak a generated value): your edit survives
  - **Conflict case** (both sides edit the same line): standard
    `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` markers — resolve like
    any git conflict; rerun `meta gen` to advance the snapshot
  - **First-time-on-existing-file**: write-if-different baseline (no merge,
    no clobber). `meta gen --baseline=fresh` opts into "overwrite from
    fresh and re-baseline"

  Add `.metaobjects/.gen-state/` to your `.gitignore`. `meta init`
  scaffolding handles this automatically. Integrity is sha-256 hashed at
  `.gen-state/.hashes.json`; tampered snapshots fall back to first-time
  semantics with a warning.

### Added
- **`templateGenerator()` stock generator** — a factory that walks
  `MetaRoot` → renders shared Mustache templates via the existing
  `@metaobjectsdev/render` engine → emits files in any format (Markdown /
  HTML / JSON / YAML / text). Establishes the framework line: **code →
  hand-coded generators (ts-poet, idiomatic per-port); documents →
  templateGenerator (shared Mustache templates, port-agnostic)**.
- **`docsFile()` refactored to use `templateGenerator()`.** Markdown
  structure now lives in
  `codegen-ts/templates/docs/entity-page.md.mustache`; adopters can
  override by placing same-named templates in their project's
  `templates/` directory. Net: ~85 LOC + a template file replaces ~250
  LOC of hand-coded string emit. Conformance fixture
  `docs-file-basic/expected/Author.md` stays byte-identical.
- **`EntityDocData` exported as a public-API contract.** Template authors
  consuming the data dict get TypeScript type-checking. Versioning policy
  spelled out in the new `docs/features/codegen-data-shapes.md`.

### Removed
- The marker-based `decideAndWrite()` path. The `<!-- @generated -->`
  HTML-comment marker that rc.11 added to docsFile output is retained as
  human-readable annotation, but the policy no longer checks for it.

## [0.7.0-rc.11] — 2026-05-28

### Fixed
- **`docsFile()` emits the `@generated` marker** in an HTML comment ahead
  of the H1 so the overwrite-policy treats subsequent `meta gen` runs as
  refreshes rather than refusing to clobber. rc.10 emitted markdown
  without the marker, which meant a second `gen` pass refused to
  overwrite the `<Entity>.md` files. Comment-based markers stay invisible
  in rendered Markdown (GitHub / VS Code / mdBook all strip HTML comments
  on render) but are present in the raw source the policy inspects.

## [0.7.0-rc.10] — 2026-05-28

### Added
- **`docsFile()` stock generator** — emits per-entity Markdown documentation
  (`<Entity>.md`) next to each generated entity file. Documents the storage
  schema, identity/relationships, validation, template cross-references,
  and generated-code surface for both `object.entity` and `object.value`.
  Adopters can aggregate the per-entity files into docs sites, OpenAPI
  descriptions, or contributor guides; AI agents have a canonical
  entity-shape reference. Markdown output is port-agnostic; C# / Python /
  Java mirrors are tracked as follow-up cross-port work.

## [0.7.0-rc.9] — 2026-05-27

### Added
- **`routesFileHono()` stock generator** — emits Hono route registration
  (`register<Entity>Routes(app, { db })`) for every writable entity,
  cross-port-API-contract-conformant with the existing Fastify
  `routesFile()`. Lets Cloudflare-Workers / Hono-server consumers
  codegen the CRUD-5 endpoints they previously hand-wrote. New helper
  `parseHonoFilterParams` ships in `@metaobjectsdev/runtime-ts/hono`
  (parallel to the existing drizzle-fastify export).

## [0.7.0-rc.8] — 2026-05-27

### Fixed
- **Java: generic required-attr enforcement.** Pre-rc.8, Java required-attr
  validation was per-subtype (an explicit block per subtype that wanted it).
  rc.8 adds a generic pass mirroring TS / C# / Python: any node whose schema
  declares `required: true` attrs that are absent on the loaded node fires
  `ERR_MISSING_REQUIRED_ATTR`. The previously-explicit R1 (prompt) and R1b
  (toolcall) blocks in ValidationPhase collapse into the generic pass.
  Closes a latent contract gap surfaced during the rc.7 cross-port
  `template.toolcall` rollout.

### Changed
- **Hardcoded type-count guards in TS / C# tests** are now derived from
  the schema constants. Previously `expect(allTypes).toHaveLength(70)` (TS)
  / `Core_provider_registers_exactly_70_types` (C#) bumped manually on every
  new subtype; now they assert each base type's subtype list directly,
  catching drift only where it matters (in the relevant subtype family
  rather than a global integer).

## [0.7.0-rc.7] — 2026-05-27

### Added
- **`template.toolcall` reaches Java + C# + Python cores** — the TS port
  shipped the subtype in rc.5/rc.6; this release brings the other three
  ports to parity per ADR-0011. Same vendor-agnostic attrs (`@toolName`
  required, `@payloadRef` required, plus governance `@owner`/`@since`).
  Same "no `@textRef` requirement" — toolcalls have no renderable body.
  Kotlin inherits the Java port. The provider-extension conformance
  fixtures (which moved to `template.briefing` in rc.5) continue to gate
  the provider-extension contract cross-port; the new core subtype gets
  its own coverage in each port's unit tests.
- **`registry.extend()` on Python `TypeRegistry`** (`@metaobjectsdev/metadata`
  Python equivalent) — closes the cross-port parity gap surfaced during
  rc.3 implementation. Same signature semantics as the TS and C# versions:
  raises `ERR_PROVIDER_ATTR_CONFLICT` on duplicate attr; `ERR_UNKNOWN_SUBTYPE`
  if the target (type, subType) isn't registered.

### Fixed
- No TS source changes vs rc.6; the version bump keeps the rc.N marker
  aligned across the four-port release surface.

## [0.7.0-rc.6] — 2026-05-27

### Fixed
- **rc.5 declared `@description` as a per-subtype attr on `template.toolcall`**,
  which conflicted with the `@description` common-attr that `docProvider` adds
  to every type — surfacing as `"Common attr 'description' conflicts with
  per-type attr on template.toolcall"` at load time. rc.5 was therefore
  unusable for any consumer with template.toolcall metadata. rc.6 removes
  the duplicate declaration; tool descriptions surfaced to the LLM read the
  same `@description` common attr that doc-gen uses. No consumer-facing API
  shift beyond the bug fix.

## [0.7.0-rc.5] — 2026-05-27

### Added
- **`template.toolcall` is now a core MO subtype** (`@metaobjectsdev/metadata`)
  per [ADR-0011](spec/decisions/ADR-0011-template-toolcall-as-core-subtype.md).
  Three vendor-agnostic attrs: `@toolName` (required), `@payloadRef`
  (required, points at the output value-object), `@description` (optional,
  surfaced to the LLM for tool selection). Plus the governance attrs
  `@owner` / `@since`.

  Critically: **`template.toolcall` does NOT inherit `genericAttrs`** the way
  `template.prompt` and `template.output` do. No `@textRef` requirement — a
  tool-call has no renderable text body; the body IS the structured output
  schema resolved via `@payloadRef`. This is the design rationale for
  toolcall being its own subtype rather than `template.output + @toolName`.

  Vendor wire details (Anthropic's retry-with-reminder, OpenAI's function-
  calling envelope, MCP's tool definitions, etc.) are NOT in core. Consumers
  add vendor specifics via `registry.extend(TYPE_TEMPLATE, "toolcall",
  { attributes: [...] })` — same pattern `dbProvider` uses for `source.rdb`.

  Cross-port rollout: TS ships in rc.5; Java / C# / Python in a follow-up.
  Kotlin inherits the Java port.

### Changed
- Conformance fixtures `provider-extension-new-subtype-success` and
  `provider-extension-missing-provider-fails` swap their test-only provider
  from `example-template-toolcall` (now meaningless — toolcall is core) to
  `example-template-briefing` (a hypothetical briefing template, clearly
  fictional). The fixtures still demonstrate `registry.register` of a new
  subtype, just using a name that doesn't collide with the new core
  subtype. TS / C# / Python adapter providers and fixture inputs/expected
  files updated to match.

- `template-constants.ts` design comment refreshed to acknowledge three
  template subtypes (prompt / output / toolcall) and document each one's
  attr-schema basis. Internal-only — no consumer-facing change beyond the
  ADR + the new exports (`TEMPLATE_SUBTYPE_TOOLCALL`, `TEMPLATE_ATTR_TOOL_NAME`,
  `TEMPLATE_ATTR_DESCRIPTION`).

## [0.7.0-rc.4] — 2026-05-27

### Fixed
- **rc.3 was packed with stale `dist/`** — the CLI's `meta gen` /
  `meta verify` / `meta migrate` / `meta prompt-snapshot` commands did
  not actually thread `config.providers` through to `loadMemory` on
  npm, even though the source had the change. Same for `loadMemory`'s
  `providers` option support in `@metaobjectsdev/sdk`. rc.4 ships with
  a fresh build so the providers API is actually live for consumers.
- Side-effect of the fixture refactor investigation: the docs
  `extending-with-providers.md` § "When to add a subtype vs. an attr"
  gained two real-world escalation triggers (existing subtype's
  required attrs don't apply; load-time error detection requires
  subtype since `@-attrs` follow open policy).

No API change vs. rc.3 — only the published artifacts now match the
documented behavior.

## [0.7.0-rc.3] — 2026-05-27

### Added
- **Consumer-supplied providers via `loadMemory({ providers })`**
  (`@metaobjectsdev/sdk`, `@metaobjectsdev/codegen-ts`, `@metaobjectsdev/cli`) —
  the SDK's `loadMemory(repoRoot, opts?)` now accepts a `providers?:
  readonly MetaDataTypeProvider[]` option. Consumers (and the codegen
  config) can register additional metamodel subtypes/attrs without
  forking the loader.

  - Defaults stay back-compatible: the bundle composed is
    `[...coreProviders, forgeTypesProvider, ...(opts.providers ?? [])]`.
    `forgeTypesProvider` is now a first-class `MetaDataTypeProvider`
    (id `"metaobjects-forge"`, depends on `"metaobjects-core-types"`);
    the legacy `registerForgeTypes()` is a thin back-compat wrapper.
  - Advanced opt-out: `loadMemory(root, { providers: [...], replaceDefaults:
    true })` skips the default bundle entirely; the caller owns the full
    provider set.
  - Codegen config: `MetaobjectsGenConfig.providers?` lets a project's
    `metaobjects.config.ts` declare its providers once. The CLI's `gen`
    / `verify` / `migrate` / `prompt-snapshot` commands all read the
    config and thread `config.providers` into `loadMemory` — no silent
    skipping, no per-command divergence.
  - Stable error codes: composition surfaces `ERR_PROVIDER_DUPLICATE_ID`,
    `ERR_PROVIDER_MISSING_DEPENDENCY`, `ERR_PROVIDER_DEPENDENCY_CYCLE`
    via `composeRegistry`. The contract is identical across Java, TS,
    C#, and Python.

- **Cross-port parity (TS / C# / Python; Java deferred).** Java already
  has SPI auto-discovery for type providers; a programmatic `compose()`
  factory parallel to TS `composeRegistry` is deferred to a follow-up.

  - **C#:** the runtime API entry is `MetaDataLoader.FromDirectory(dir,
    registry)`, which already takes a custom registry; `Provider.
    ComposeRegistry(providers)` is the supported composition surface.
    New `ProviderExtensionTests` (6 cases) assert the cross-port
    contract end-to-end.
  - **Python:** `MetaDataLoader.from_directory(dir, providers=...)`
    already accepts a provider list; the conformance adapter now
    discovers `providers.json` per fixture (parity with C#). New
    `tests/unit/test_provider_extension.py` (5 cases) mirrors the TS
    test suite.

- **5 conformance fixtures** under `fixtures/conformance/` exercising
  the contract cross-port:
  `provider-extension-new-subtype-success` (positive: a test-only
  `example-template-toolcall` provider registers `template.toolcall`),
  `provider-extension-missing-provider-fails` (`ERR_UNKNOWN_SUBTYPE`),
  `provider-extension-dependency-cycle` (`ERR_PROVIDER_DEPENDENCY_CYCLE`),
  `provider-extension-missing-dependency`
  (`ERR_PROVIDER_MISSING_DEPENDENCY`), and
  `provider-extension-duplicate-id` (`ERR_PROVIDER_DUPLICATE_ID`).
  Each fixture's `providers.json` is the public seam — explicit
  `providers` declarations bypass any ambient discovery, so the
  fixture's declared set is exactly the set the loader composes.

## [0.7.0-rc.2] — 2026-05-27

### Added
- **`entityFile({ allowlists: false })` opt-in flag** (`@metaobjectsdev/codegen-ts`) —
  Worker/Lambda consumers can disable the Fastify-flavored
  `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` emission. Generated
  entity files then carry no `@metaobjectsdev/runtime-ts/drizzle-fastify`
  imports at all and `runtime-ts` can be omitted from the consumer's deps
  entirely. The client-side `<Entity>Filter` type is still emitted (zero
  runtime-ts dependency). Default remains `true` for back-compat; consumers
  using `routesFile()` should leave the default. Closes the long-term
  recommendation from the 0.7.0-rc.1 Worker-consumer friction batch
  (commit bd0bcb8).
- **Loader error envelope + source-on-node** (`@metaobjectsdev/metadata`) —
  per [ADR-0009](spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md),
  every `MetaData` node now carries a `source: ErrorSource` provenance field
  (`{ format: "json", files: [...], jsonPath: "..." }` for loaded nodes;
  `{ format: "code" }` for programmatically constructed). `ParseError` now
  conforms to the cross-port `LoaderError` schema: required `code`, required
  `message`, required `source` envelope. New `LoadResult.warnings:
  LoaderWarning[]` channel (legacy parser/validator strings are wrapped at
  the loader boundary as `WARN_LEGACY` envelopes; future overlay-merge
  detection in FR5c will be the first feature to emit native envelope-shaped
  warnings). New public exports from `@metaobjectsdev/metadata`:
  `ErrorSource`, `LoaderError`, `LoaderWarning`, `NodeContext`, `Contributor`
  types, plus the `codeSource()` helper. Foundation for FR5b (YAML
  positions), FR5c (multi-file merge attribution), FR5d (reference-resolution
  errors), FR5e (database-source errors).
- **`outputParser()` stock generator** in `@metaobjectsdev/codegen-ts/generators` —
  for every declared `template.output`, emits a typed Zod parser file with a
  dual-API surface (`parseXxx(text)` throws, `safeParseXxx(text)` returns
  Result). Field-type → Zod-type mapping covers all scalars, arrays, and
  nested `field.object` with `@objectRef`. The emitted file is self-contained
  (no cross-file payload import) and exports a `<TemplateName>Data` type-alias
  derived via `z.infer`; consumers who also wire `promptRender()` can use the
  payload-VO interface from `prompts.ts` interchangeably (structurally
  identical). Wire it into `metaobjects.config.ts`:
  `generators: [..., outputParser()]`.
- **`meta verify` extension** for `template.output` drift — the build-time
  drift gate now checks both subtypes. Output diagnostics carry `(output)`
  prefix; prompt diagnostics gain `(prompt)` prefix for symmetry.
- **Conformance fixture `template-output-simple`** — shared cross-language
  corpus gains `input/meta.npc.json`, `expected.json`, and
  `expected/NpcResponseOutput.output.ts` byte-exact codegen artifact. TS
  conformance runner verifies `outputParser()`'s output matches.
- **`source.rdb` discriminator filters entity-file emission**
  (`@metaobjectsdev/codegen-ts`) — metaobjects without a writable
  `source.rdb` child now route through a streamlined value-only path
  emitting only the structural TS interface + `<Name>InsertSchema` Zod
  schema. The Drizzle table, `InferSelectModel`/`InferInsertModel`
  aliases, `<Entity>FilterAllowlist`/`<Entity>SortAllowlist`,
  `<Entity>Filter` type, and `$entity`/`$table`/`$path` constants object
  are skipped entirely. Pure metadata-driven discriminator (type=`source`,
  subtype=`rdb`, `MetaSource.isWritable()`) — not an `object.value`
  vs `object.entity` type-ID gate, so the same filter also covers
  transient / in-memory shapes that declare no source. Closes the
  "dead generated tables" smell in consumers that model nested response
  payloads as value objects. Branch slots between `isProjection` and
  the existing vanilla-entity path; both pre-existing paths are
  unchanged. New helper `hasWritableRdbSource(entity)` from
  `@metaobjectsdev/codegen-ts/source-detect`.
- `meta verify` log line format adds `(<subtype>)` after the template name
  (e.g., `[npcTurn] (prompt) ERR_*`). A pre-FR6 log scraper that matched
  on the bare `[name]` prefix needs to update its regex.
- **BREAKING (codegen-ts):** Generated `<Entity>.queries.ts` CRUD helpers now
  accept a Drizzle `db` instance as the **first parameter** of every function
  (`findUserById(db, id)`, `listUsers(db, opts)`, `createUser(db, data)`,
  `updateUser(db, id, data)`, `deleteUserById(db, id)`). The module-level
  `import { db } from "<dbImport>"` line is no longer emitted; instead, every
  file declares a dialect-correct `type Db = ...` alias at the top. Migration:
  bump, regen, search-and-replace call sites — see the new
  [wiring-generated-queries.md](docs/recipes/wiring-generated-queries.md)
  recipe for the full guide. Background: [ADR-0008](spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md).
  Enables Cloudflare Workers / edge consumers to drop their typecheck stubs;
  enables multi-tenant servers + test-isolated `db` setups. `routesFile()` is
  unchanged.
- **BREAKING (metadata):** `ParseError` constructor signature changed. Was
  `new ParseError(msg, { code?, source?: string, path? })`; now
  `new ParseError(msg, { code, source: ErrorSource })`. Direct construction
  outside the metadata package is rare (loader-internal API), but anyone
  catching + repackaging a `ParseError` reads `.source` as the new envelope
  type, not a string. Legacy `error.path` is gone — read
  `error.source.jsonPath` instead.
- **BREAKING (metadata):** `LoadResult.warnings` retyped from `string[]` to
  `LoaderWarning[]` per ADR-0009. Consumers that inspected warning content
  via `result.warnings[i].includes(...)` should now read
  `result.warnings[i].message.includes(...)`. The public
  `ExportResult.warnings` (returned by `loadAndExportJson()`) keeps its
  `string[]` shape — extracted via `.map((w) => w.message)`.

See [ADR-0010](spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port design.

### Fixed
- **`@metaobjectsdev/cli` now pulls `@metaobjectsdev/runtime-ts` transitively.**
  Generated entity files emit `import type { FilterAllowlist, SortAllowlist }
  from "@metaobjectsdev/runtime-ts/drizzle-fastify"` unconditionally; until
  now, consumers who installed only `cli` (the recommended umbrella) hit
  unresolved-import errors on the first `meta gen`. `cli` now declares
  `runtime-ts` as a runtime dependency at the same pinned workspace version.
  The imports are type-only, so the addition has no Worker/Lambda bundle
  impact. (Reported from a 0.7.0-rc.1 Worker consumer.) Long-term, an opt-in
  flag on `entityFile({ allowlists: false })` will let Workers consumers skip
  the imports entirely — that's a separate follow-up.
- **`meta migrate --dialect d1` no longer fails against wrangler's local D1
  sandbox.** `introspectD1` was calling `SELECT sqlite_version()` to populate
  `SnapshotMeta.sqliteVersion`, but workerd blocks that function in the local
  D1 sandbox. The introspector now tries the call once and falls back to a
  static known-good version (`"3.44.0"` — matches Cloudflare D1's shipped
  SQLite) on failure. Remote `wrangler d1 execute` paths still answer the
  function and use the live value. (Reported from the same 0.7.0-rc.1
  consumer.)
- **`field.enum` columns emit Drizzle `text({ enum: [...] as const })`**
  (`@metaobjectsdev/codegen-ts`) — CHECK-constrained enum columns now
  carry an `enum` option on the `text()` call, narrowing Drizzle's
  inferred select-model type from bare `string` to a literal union
  (e.g. `"supports" | "opposes" | ...`). The `as const` suffix is what
  Drizzle's type signature requires to lift the values into the type
  position. Affects every non-array `field.enum`; isArray enum columns
  remain `text({ mode: "json" })` (Zod still validates element membership).
- **`field.object isArray:true objectRef:RefName` emits
  `text({ mode: "json" }).$type<RefName[]>()`**
  (`@metaobjectsdev/codegen-ts`) — SQLite JSON columns storing arrays
  of nested objects now carry a typed element annotation via ts-poet
  `imp()` cross-module hoisting (e.g. `citations: text("citations", {
  mode: "json" }).$type<SourceLens[]>()`). Sibling fix to the scalar
  `.$type<E[]>()` patch from 0.7.0-rc.1; closes the last row-type
  widening case that forced consumers to `as unknown as z.ZodType<>`
  cast the codegen'd `<Name>InsertSchema` at the LLM-tool-use boundary.

## [0.6.0] — 2026-05-25

### Added
- **Cloudflare D1 dialect for `meta migrate`** — `--dialect d1`,
  `meta init --d1`, `wrangler.toml` binding resolution, `introspectD1` via
  shell-out, `renderD1` = `renderSqlite` + D1-safety post-pass (strip explicit
  txns, reject `ATTACH`/`VACUUM`), `writeMigrationD1` (Wrangler
  `<seq>_<slug>.sql` + `.down/` sidecar), optional `--apply` hook. See
  [`docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`](docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md).
- Projection (`source.dbView`) migrations now emit DDL for D1 alongside
  Postgres/SQLite.
- New `render` package added to the publish-candidate set (Tier 0); 12
  packages now released in lockstep.

### Changed
- `Dialect` union extended to include `"d1"`; existing `"sqlite"` /
  `"postgres"` paths unchanged.
- `MigrateBlock` in `.metaobjects/config.json` gained an optional `d1`
  sub-block (`binding`, `remote`, `autoApply`, `wranglerConfigPath`).
- Generated `deleteXById(...)` helpers now use `.returning()` so the
  response shape is portable across D1, libsql/Turso, and Postgres (was
  previously libsql/Turso-specific).

### Fixed
- SQL injection in `introspectD1` pragma calls via crafted SQLite identifier
  names; pragma queries now double-quote-escape identifiers (the Kysely-based
  `introspectSqlite` path was already safe via Kysely's parameterization).
- Removed dead `parseWranglerExecuteJson` export from `cli/lib/wrangler.ts`.
- `codegen-ts/src/templates/jsdoc.ts` now satisfies `exactOptionalPropertyTypes`.

### Security
- Pragma identifier injection patched in the D1 introspector; see Fixed.

## [0.5.0] — 2026-05-23

First public release. 11 publish-candidate packages on `latest`; `cli` shipped
as `0.5.1` patch shortly after. Projects D–G shipped end-to-end (typed filter
syntax, source-aware entities + projections, currency, TanStack codegen).
See [`spec/roadmap.md`](spec/roadmap.md) for the full Projects D–G coverage.
