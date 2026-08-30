# Name constants and magic-string elimination — design

**Date:** 2026-08-30
**Status:** proposed — not yet approved for implementation
**Scope:** all five ports (TypeScript, C#, Java, Kotlin, Python), the agent-context skills,
and the metaobjects.dev codegen snippets. Three programs; they can be planned and shipped
independently, and Program A has a hard prerequisite (§A4).

## Summary

Two related programs, deliberately separated because they have different sources of truth,
different consumers, and different risk profiles:

- **Program A — data names.** Generate, per declared object, the physical database names
  (table / view / materialized view / stored proc / table function, schema) and per field
  the logical name and physical column name, as constants a hand-written consumer can
  reference instead of a string literal.
- **Program B — metamodel vocabulary names.** Generate, per port, constants for every
  registered type name, subtype name and attribute name, so that no code in this repo or
  in an adopter's provider/tooling spells `"object.entity"` or `"@column"` as a literal.
- **Program C — a read-only startup schema validator**, per port, closing the one link in
  the chain that no build-time gate can reach: whether the database *this running process is
  actually connected to* matches the metadata it just loaded.

They share one goal — **eliminate magic strings** — and one doctrinal home: the
`metaobjects-*` skills must teach it in every language, which today they do not.

Neither program adds metamodel vocabulary. Both read what is already registered, so
[ADR-0023](../../../spec/decisions/ADR-0023-strict-metadata-provenance.md) is satisfied by
construction and `metamodelVersion` does not move.

---

## Why now, and what is actually broken

The proposal arrived as "we should do this." Investigation found it is **already half-built,
already subtly wrong, and already inconsistently taught.**

1. **Program A exists for projections and nowhere else.**
   `codegen-ts/src/templates/projection-decl.ts:144` emits a per-field `dbCol`, visible in
   `examples/advanced-modeling/src/generated/ProgramSummary.ts` (`dbCol: "author_name"`,
   `dbCol: "lesson_count"`). The *entity* emitter (`entity-constants.ts`) emits no such key.
   `grep -rn '\.dbCol'` finds **zero consumers** — the only hits are `dbColAlias`, an
   unrelated field in the view-DDL path. So a physical-column constant is already generated,
   always-on, purely for hand-written consumers, in exactly one of two emitters, and unused.

2. **That `dbCol` is computed by the wrong resolver — a live latent bug.**
   `projection-decl.ts:141` calls `columnNameFromField(f.name, strategy)`, whose signature
   (`naming.ts:41`) takes a **string**, so it structurally cannot read `@column`. The
   correct resolver sits beside it: `metadata/src/naming.ts:88` `resolveColumnName(field,
   strategy)` reads `field.attr(FIELD_ATTR_COLUMN)` first and falls back to the strategy.
   A projection field inheriting `@column` through `extends` therefore gets a `dbCol` that
   disagrees with the column the DDL actually emits. It is unobservable in-repo today only
   because no example model declares a `@column` that differs from the naming strategy's
   answer — the "a corpus that loses coverage fails nothing" pattern.

3. **`$table` already holds names that are not tables.** `resolveTableName`
   (`metadata/src/naming.ts:69`) delegates to `source.physicalName` for **any** `@kind`;
   its own comment says writability "only affects write-routing." So `$table` can already
   contain a view or stored-proc name. Any new artifact must carry `{ kind, name }` rather
   than kind-specific keys.

4. **Program B is hand-maintained in one port and absent in two.** TypeScript carries
   **485** hand-written constants across 14 per-concern `*-constants.ts` modules, barreled
   into a browser-safe `@metaobjectsdev/metadata/constants` entry. Java has scattered,
   partial `*Constants.java` files. **C# and Python have no metamodel-constants file at
   all.** The registered surface is 14 type names, 69 `type.subtype` pairs, 107 distinct
   attribute names and 422 attribute registrations.

5. **The doctrine is TypeScript-only and already drifting.** "Use the generated constants.
   Never use magic strings" lives solely in `sdk/src/agent-docs/body.ts`, which teaches
   `$entity`/`$table`/`$path` but not the `$apiPrefix` that `entity-constants.ts:227`
   emits. `docs/ports/{java,kotlin,python,csharp}.md` never mention a descriptor at all.

---

## What a name constant does and does not buy

This must be stated exactly, because the obvious pitch is wrong and it will end up in the
skills and on the website.

A constant does **not** catch a physical-column rename. Change `@column: created_at` to
`signup_at` while the field stays `createdAt`, and `Subscriber.createdAt.column` silently
changes value. Code that used the constant is now correct; code that used the literal
`"created_at"` is now wrong, and nothing says so. **The compile error fires only on a
*logical* rename**, where the identifier `createdAt` itself disappears.

The three real benefits, in order of value:

1. **Propagation.** Hand-written SQL follows a physical rename automatically. This is the
   biggest win and it is a better story than the compile-error one.
2. **Compile error on a logical rename**, where the identifier is gone.
3. **A safe identifier whitelist.** SQL identifiers cannot be parameterised — only values
   can — so a column name in raw SQL must be a literal or a constant. Where the identifier
   is influenced by anything external, a fixed generated set is the only safe form. This is
   the strongest argument in C#, where raw SQL is common and `nameof()` gives the CLR
   property, never the column.

**Where a typed handle already exists, prefer the typed handle.** jOOQ's
`SUBSCRIBERS.CREATED_AT`, Exposed's `Subscribers.createdAt`, and Drizzle's
`subscribers.createdAt` are all compile-safe and strictly better than a bare string. The
generated constants are for the **raw-string boundary**: raw SQL, migrations, annotation
arguments (which require compile-time constant expressions), and external tools. The skills
must say this rather than recommending constants over typed handles everywhere.

### Prior art

| Ecosystem | What it gives | Physical column name |
|---|---|---|
| jOOQ (Java) | `Tables.AUTHOR.ID` — typed `TableField` | `.getName()` at runtime; [#11920](https://github.com/jOOQ/jOOQ/issues/11920) asked for `static final String` (annotations need constant expressions), closed as duplicate |
| Lombok `@FieldNameConstants` | Per-class **inner type** of constants | Logical only — not schema-aware |
| Prisma (TS) | `<Model>ScalarFieldEnum` — logical names | **No.** `@map`ped names only via DMMF, documented as internal ([#14087](https://github.com/prisma/prisma/issues/14087)) |
| SQLAlchemy | Three distinct naming layers: attribute, `Column.key`, `Column.name` | Runtime, via `__table__.c` |
| Django | `_meta.get_field("x").column` | Runtime, underscore-private, and the lookup takes a **string** |
| EF Core | `nameof()` (CLR property) + model metadata API | Runtime |
| Exposed (Kotlin) | `val email = varchar("email", 320)` | `.name` at runtime |

**No mainstream tool emits a compile-time physical-name constant, and users keep asking
for one.** That is the gap this fills. One caution from the same survey: a single global
`Tables`/`Columns` class is the constant-interface anti-pattern; constants must be
co-located per object, which is also what Lombok and jOOQ do.

---

## Program A — data-name constants

### A1. Shape: a separate artifact, per port idiomatic

**Decision: a new generator emitting one file per object, in each port's own idiom.**
Not folded into the entity descriptor, the DTO, the record, or the data class.

Three facts drive this:

- **Four of five ports have no descriptor to extend.** "Extend the descriptor" is only
  available in TypeScript. If the feature ships cross-port, a new artifact is built in four
  ports regardless, and merging in TS alone makes TS the odd one out on the axis this
  project protects hardest — one concept, taught once, recognisable in every port.
- **The repo has already answered "what shape per language."** The FR-009 filter allowlist
  is the same problem — a per-entity name-constants artifact — and it already ships in all
  five ports in five idiomatic shapes. Copy an accepted idiom rather than invent one.
- **A DTO/record/data class is a wire shape**, and a name registry is not.

| Port | Shape to copy (from the filter allowlist) |
|---|---|
| TypeScript | `export const SubscriberNames = { … } as const` |
| C# | `public static class SubscriberNames { public const string … }` — `const`, not `static readonly`, so it is usable in attribute arguments and `switch` patterns |
| Java | `public final class SubscriberNames { public static final String … }` + private constructor |
| Kotlin | `object SubscriberNames { const val … }` — `const val` for compile-time inlining |
| Python | Module-level `Final` constants in `subscriber_names.py` |

**Do not force one shape.** [ADR-0020](../../../spec/decisions/ADR-0020-codegen-tiering-native-vs-neutral.md)'s
dividing test puts target-language source at Tier 1 (per-port, idiomatic), and the
cross-port codegen-output corpus was **formally rejected** (FR-007, `fixtures/codegen-conformance/README.md`,
rejected 2026-05-26, re-confirmed 2026-05-31: "each port's catalog is idiomatic-divergent by
design"). Consequence, stated plainly: **this artifact gets no cross-port conformance
protection.** Nothing generated reads it, so no behaviour corpus can catch drift in it.
Per-port goldens are the only gate, and the design must budget for them.

### A2. Content

Per object:

- `{ kind, schema, name }` — **not** kind-specific keys, because `$table` already lies
  (finding 3 above). `kind` is the `source.rdb @kind` value; `name` is the physical name;
  `schema` comes from `resolveTableSchema` and is absent when undeclared.
- `readOnly`, derived from the source kind.

Per field:

- `{ name, column }` — the logical name and the physical column name, always both, always
  distinguished. SQLAlchemy keeps three naming layers apart deliberately; a shape that lets
  a caller reach "the name" without knowing which one they got is a bug generator. The
  showcase already has the collision: field `createdAt`, column `created_at`.

### A3. Resolution — the load-bearing rule

**Every name must be produced by the same resolver, in the same generator run, with the
same arguments, as the DDL/ORM binding it describes.** Column naming is *config*, not
metadata — `KotlinExposedTableGenerator.kt:44-56` states this outright — so a constant
emitted from a different run or a different default is a plausible-looking lie.

Concretely: `resolveTableName` / `resolveTableSchema` / `resolveColumnName` in TypeScript,
`resolve_column_name` in Python, `MetaSource.PhysicalName` in C#, `getTableName()` +
`ATTR_COLUMN` on the JVM — with the `columnNaming` argument threaded through.

### A4. Prerequisite — fix the resolver bug first, on its own

`projection-decl.ts:141` must call `resolveColumnName(field, strategy)` instead of
`columnNameFromField(f.name, strategy)`. This is a bug today, independent of this feature.
Ship it as its own change, with a regression fixture whose field declares a `@column` that
differs from the naming strategy's answer — the coverage gap that hid it.

Leave the existing `$table` and `dbCol` keys where they are. Removing them buys nothing and
breaks ejected copies.

### A5. Defaults follow the selection lever, not appetite

Each port's generator-selection mechanism decides what "always-on" can even mean:

- **TypeScript — opt-in for existing adopters, by construction.**
  [ADR-0034](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md) scaffold-and-own:
  `cli/src/commands/init.ts:31` copies generators into the adopter's repo and `meta gen` runs
  *their* copy. A packaged template change cannot reach anyone who has ejected. The honest
  maximum is adding `"names"` to `SCAFFOLDED_GENERATOR_NAMES` so every new `meta init` gets
  it, plus a documented one-line config addition for existing projects.
- **Java / Kotlin — opt-in by construction.** Generators are selected by FQCN in `pom.xml`.
  A new generator class is invisible until someone lists it.
- **C# / Python — default ON.** Both have a hardcoded default suite
  (`GenCommand.DefaultGenerators()`, `cli.py:_default_generators()`), and both have the
  largest real gap: C# carries physical names only inside attribute arguments, and the
  generated Python model is a bare Pydantic class with no ORM binding at all, so there is no
  other route to the name.

Implement it as a **separate generator, never a boolean on the entity generator.** A new
generated artifact is a MINOR under `docs/compatibility-policy.md`, adds zero bytes to
existing files, and sidesteps the descriptor entirely. A flag on the entity generator would
change bytes in every `$table`-carrying golden and its sibling forms/queries/routes for the
same functionality.

**Standing cost of ON anywhere:** `verify --codegen` fails until each adopter regenerates.

---

## Program B — metamodel vocabulary constants

### B1. The problem

`AGENTS.md` already states the rule — "named constants in `packages/metadata/src/constants.ts`.
Never inline metamodel strings as literals in code" — and it is honoured in exactly one port.
TypeScript hand-maintains 485 constants; Java is partial and scattered; **C# and Python have
none**. Any adopter writing a metadata provider, a custom generator, or tooling against
MetaObjects in those languages has no choice but to spell `"object.entity"` and `"@column"`
as literals.

### B2. Source of truth

`fixtures/registry-conformance/expected-registry.json` — the canonical manifest every port
already emits and byte-matches. It is the only artifact in the repo that is *proven* to
agree with all five registries, which makes it the correct input and makes generation safe
by construction.

### B3. Generate or hand-code-and-verify?

**Decision: generate in the ports that have no curated set (C#, Python, Kotlin, Java);
verify coverage in TypeScript, where a curated set already exists and is a published export
surface.**

The reasoning is that the two halves are answering different questions:

- Where nothing exists, generation is strictly better: 107 attribute names and 69
  `type.subtype` pairs is not a set anyone will hand-maintain correctly in four languages,
  and the drift record in TS (`body.ts` teaching `$apiPrefix`-less constants) shows what
  hand-maintenance costs even in the port that cares most.
- In TypeScript the 485 constants are **semantically named and publicly exported**
  (`FIELD_ATTR_MAX_LENGTH`, `VIEW_SUBTYPE_TEXT`). Their names are curated, not mechanical.
  Regenerating them would either break the export surface or require reproducing hand-made
  naming decisions in a generator. The right gate there is **coverage**: prove every
  registered vocabulary member has a constant, and fail the build when a new one is
  registered without one.

`scripts/check-metamodel-version.mjs --set` is the precedent for a script that writes into
all four port constant files at once.

### B4. The gate

A new check, modelled directly on `metadata/src/registry-coverage.ts`, which already walks
the manifest and reports registered-but-unexercised vocabulary. Same mechanism, different
right-hand side: **registered vocabulary vs. constants that exist**, per port.

- Fails when a registered type, subtype or attribute has no constant in a port.
- Fails when a constant's *value* disagrees with the manifest.
- Runs in the `gates` lane, which is offline and already reads this manifest.

This is the piece that makes the whole thing durable. Without it, four newly-generated
constant sets rot the first time vocabulary is added — which is exactly how TypeScript's
own curated set drifted.

### B5. Naming rule

One deterministic rule, applied per port with that port's casing convention, so a reader who
knows one port can predict the others:

- type → `OBJECT`, `FIELD`, `SOURCE`
- `type.subtype` → `OBJECT_SUBTYPE_ENTITY`, `FIELD_SUBTYPE_STRING`
- attribute → `FIELD_ATTR_MAX_LENGTH`, `SOURCE_ATTR_TABLE`

These match the TypeScript names already in use, which is why TS is the reference and not
the exception.

---

## Program C — read-only startup schema validation

### C1. Why this is not a revival of what ADR-0015 removed

The Java port once shipped `MetaClassDBValidatorService`: it verified each MetaObject's
table/view mapping against the live database **and created what was missing** — tables,
sequences, indexes, foreign keys, views — under an `autoCreate` flag
(`docs/superpowers/specs/2026-05-22-fr-003-…-design.md:17`).

[ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) removed it, and
the ADR names exactly what it removed: "Java's OMDB runtime schema **auto-create** path
(`MetaClassDBValidatorService` + the drivers' `createTable`/`createIndex`/`createForeignKey`/
`createSequence` DDL) was **also removed** — OMDB is now pure data-access." Every deleted
capability is a **write**. The read half went with it only because the two were one service
behind one flag.

ADR-0015 is about schema **authority** — who is allowed to emit DDL, and the answer is the
TypeScript toolchain alone. A validator that only introspects and compares claims no
authority. **Program C is read-only by hard rule: it emits no DDL, ever, under any flag.**
That is the line that keeps ADR-0015 intact, and it is not a soft guideline — an
`autoCreate` option must not exist, because its existence is what made the last one
removable.

### C2. The gap it closes

The existing gates are build-time and, for the schema link, Node-only:

| Gate | When | Which ports | What it proves |
|---|---|---|---|
| `verify --codegen` | build | all five | generated code and constants match the metadata |
| `verify --db` | build / CI | **Node only** | metadata matches the DB *the developer or CI* pointed at |
| `verify --replay` / `--replay-snapshot` | build | Node only | the committed migration chain applies and rebuilds the recorded snapshot |
| **Program C** | **process start** | **the port the service runs in** | the DB **this process is connected to** matches the model it just loaded |

The failure classes only Program C can see: the deployed artifact pointed at the wrong
database; a migration that never ran in *this* environment; a hand-patched production table;
a read replica behind on schema; two services sharing one database where one shipped a newer
model.

The strongest form of the argument is a direct consequence of ADR-0015: **the four ports that
cannot run `verify --db` are the four that most need this.** A Java, Kotlin, C# or Python
service runs against a schema it does not own and today has no mechanism at all for detecting
that the schema disagrees with the metadata it loaded. Centralising schema authority in Node
was right; leaving the other four ports blind at runtime was its unpriced cost.

### C3. Compare against the committed snapshot, not against metadata

The obvious implementation — each port diffs live introspection against loaded metadata — is
wrong, because it re-forks the diff engine ADR-0015 consolidated into one place, in four
languages, and that is the exact failure the ADR was written to end.

Instead: **each port compares live introspection against the committed schema snapshot** that
the TypeScript toolchain already produces and that `verify` has gated since
[#292](https://github.com/metaobjectsdev/metaobjects/issues/292). Each port then needs only
(a) dialect-specific introspection queries and (b) a comparison of two schema descriptions —
never a diff engine, never a notion of what the schema *should* be derived independently.

This also completes the chain, and is why the three programs belong in one spec. Each link is
checked somewhere, by something already built:

```
metadata --(verify --codegen)--> generated code + name constants   [every port, build]
metadata --(verify --db, #292)--> committed schema snapshot          [Node, build]
snapshot --(verify --replay-snapshot)--> migration chain             [Node, build]
snapshot --(Program C)--> the live DB this process uses              [every port, boot]
```

A wrong physical name in a generated constant would have to survive all four to reach
production, and it cannot, because every link is anchored to the same metadata.

**Where the chain genuinely breaks, stated honestly:** column naming is *config*, not
metadata (`KotlinExposedTableGenerator.kt:44-56`). Two ports generating against one database
with different `columnNaming` settings each pass their own `verify --codegen` while
disagreeing with each other. The composition therefore holds only while the naming config
agrees across ports — which is a strong argument for **declaring `@column` explicitly**, since
a declared physical name is config-independent. The showcase model already does this, and its
comment already says why.

### C4. Open shape questions

- **Fail-fast or warn?** A startup gate that hard-fails takes down a fleet on a false
  positive, and the schema-drift engine has a false-positive history (the D1 phantom-drift
  batch in 0.20.2). Boot is a worse place to be wrong than CI. Likely: warn by default, fail
  on an explicit opt-in, never silent.
- **How deep?** Table/view presence, column presence, nullability and a coarse type class is
  probably the whole valuable set. Full type fidelity re-creates the diff engine by degrees.
- **Cost.** Dialect-specific introspection (`information_schema`/`pg_catalog`,
  `PRAGMA table_info`, …) × four ports. Scope discipline decides whether this is small.

## The doctrine, and where it is taught

Getting rid of magic strings is the point; the constants are only the mechanism. The
highest-leverage work is the part that reaches adopters:

- **All six `metaobjects-*` skills** must teach it, in every language — not just
  `metaobjects-codegen`. Today the doctrine exists only in `sdk/src/agent-docs/body.ts`,
  which is TypeScript-only.
- **`docs/ports/{java,kotlin,python,csharp}.md`** must document the names artifact and the
  vocabulary constants. They currently do not mention a descriptor at all.
- **The metaobjects.dev snippets** should show the constants in use, which is the original
  motivation. This is downstream of the codegen work and lands through the site payload
  program (`docs/superpowers/plans/2026-08-29-website-self-updating-codegen.md`).
- The skills must carry the honest framing from "What a name constant does and does not
  buy" — including *prefer the typed handle where one exists*. A skill that tells an agent
  to replace `subscribers.createdAt` with a string constant would make generated code worse.

---

## Non-goals

- **No new metamodel vocabulary.** Both programs read what is already registered.
- **No cross-port shape uniformity for Program A.** FR-007 is rejected doctrine; each port
  is idiomatic and gated by its own goldens.
- **No removal of `$table` / `dbCol` / the existing descriptor keys.** Additive only.
- **Not a runtime metadata API.** These are compile-time constants; the reflective routes
  each ORM already offers are unaffected and, where they are typed handles, preferred.
- **No DDL from Program C, under any flag.** No `autoCreate`, no create-if-missing, no
  "just for dev". Schema authority stays with the TypeScript toolchain (ADR-0015). The
  option's *existence* is what made the previous validator removable.

---

## Open questions

1. **Python default for Program A.** Recommended ON, because no other route to the physical
   name exists in the generated Python surface. The counter-argument is that Python has no
   compiler, so enforcement is a type-checker catch at best, making it the lowest-payoff
   port. Worth a second look before implementation.
2. **Whether Program B should also generate the TypeScript set** rather than gating its
   coverage. Recommended as coverage-only above, but if the curated names turn out to be
   mechanically derivable after all, one generator for five ports is simpler than a
   generator plus an exception.
3. **Program C's failure mode and depth** — see §C4. Warn-by-default with opt-in
   fail-fast is the likely answer, but boot-time behaviour deserves its own decision rather
   than inheriting CI's.
4. **Whether Program C is one FR or three.** It has an independent justification (four ports
   are blind at runtime today) and could be specced separately. It is here because it closes
   the last link in the same source-of-truth chain, which is only visible when all three are
   read together.
5. **Whether the motivating adopter code is TypeScript-only.** If it is, Program A's
   "separate artifact in five ports" arithmetic collapses and merging into the existing TS
   descriptor becomes the cheaper right answer — it was verified safe (see below).

## Verified during design

- Adding a per-field key to the TS descriptor is **safe**: `use-entity-form.tsx:120-131`
  skips `$`-prefixed keys and then builds input props by explicit allowlist
  (`registered`, `aria-label`, `type`, `placeholder`). It never spreads the field object,
  so a new `column` key cannot reach the DOM. This removes the only concrete objection to
  merging; the decision above rests on cross-port arithmetic, not on that risk.
- The showcase emits no `Subscriber.meta.ts` — the browser-safe module is emitted only by
  the UI generators, so it is not universally present.
- `docs/compatibility-policy.md` prices a new generated artifact as a **MINOR** and states
  that generated-code internals are not a public API.
