# Registry Conformance

A structural gate for the cross-language contract that **the metamodel subtype
vocabularies must be identical across languages** (see CLAUDE.md →
"Cross-language porting"). Each of the five ports (TypeScript, C#, Java, Kotlin,
Python) walks its own type registry and serializes the **logical metamodel
vocabulary** as a canonical, fully-sorted, byte-stable JSON manifest. A
conformance runner asserts that manifest is **byte-identical** to the single
committed canonical, [`expected-registry.json`](./expected-registry.json).

## Why this exists

The "vocabularies identical across languages" rule was previously enforced only
by manual discipline ("add to the TS constants first, then mirror in the other
ports") plus *incidental* behavioral coverage — a drifted attr was caught only
if some fixture happened to exercise it. That misses things: the SP-C work found
the Java validator vocabulary had drifted for weeks (`@mask` vs `@pattern`, a
`NumericValidator` with no min/max, an `ArrayValidator` with `@minSize`, and the
Python loader not registering `length`/`regex`/`numeric`/`array` at all) — all
silent, because no behavioral fixture exercised that vocabulary. There was no
test comparing the **registries themselves**. This is that test.

This is the same proven pattern as `render-conformance` and
`output-prompt-conformance`: byte-exact to a single committed canonical —
strongest signal, simplest model, no escape-hatch ledger. The logical
vocabulary must have **zero** per-port divergence by contract.

## Manifest schema (v1)

```jsonc
{
  "types": [                                 // sorted by "type.subType"
    {
      "type": "validator",
      "subType": "regex",
      "attrs": [                             // sorted by name
        { "name": "max",     "valueType": "int",    "isArray": false, "required": false },
        { "name": "min",     "valueType": "int",    "isArray": false, "required": false },
        { "name": "pattern", "valueType": "string", "isArray": false, "required": false }
      ]
    },
    {
      "type": "field",
      "subType": "enum",
      "attrs": [
        // An array-valued attr: the SCALAR value-type plus an explicit isArray
        // flag. There is NO "stringarray" valueType token and NO attr.stringarray
        // subtype — array-ness is a single orthogonal axis (the isArray flag),
        // matching Java's `StringAttribute + @isArray` model.
        { "name": "values", "valueType": "string", "isArray": true, "required": true }
      ]
    }
  ],
  "commonAttrs": [                           // sorted by name — the registerCommonAttribute set
    { "name": "description", "valueType": "string", "isArray": false, "required": false }
  ],
  "defaultSubTypes": { "metadata": "root", "object": "entity" }  // sorted keys
}
```

### Serialization contract (every port MUST match byte-for-byte)

- 2-space indentation.
- Object key order is fixed by construction: `types`, `commonAttrs`,
  `defaultSubTypes`; each type as `type`, `subType`, `attrs`; each attr as
  `name`, `valueType`, `isArray`, `required`.
- **Everything sorted** (locale-independent, ASCII codepoint compare):
  `types` by `"<type>.<subType>"`; each `attrs` array by `name`; `commonAttrs`
  by `name`; `defaultSubTypes` keys sorted.
- `valueType` is the attr's **scalar** value-type (`string`/`int`/`boolean`/…),
  or `null` (literal) for polymorphic/untyped attrs (e.g. `@default`, whose value
  type follows its owning field's subtype).
- `isArray` is a boolean: `true` for an array-valued attr (a list of the scalar
  `valueType`), `false` otherwise. Array-ness is modeled as a single orthogonal
  axis — there is no `stringarray` value-type token and no `attr.stringarray`
  subtype. A polymorphic attr (`valueType: null`) is `isArray: false`.
- A single trailing newline.

The TS emitter (`server/typescript/packages/metadata/src/registry-manifest.ts`,
`emitRegistryManifest`) is the reference implementation; the TS constants are
the documented source of truth.

## In / out boundary — a principled classification, not a name-match

The guiding rule: **include a facet only if it is part of the cross-port logical
contract AND all five ports can emit it identically.** A smaller airtight
manifest beats a bigger flaky one — when unsure, exclude from v1 and document the
deferral.

**How the in/out decision is made (Wave 3b — principled, not a tautology).** The
boundary used to be a bare exclusion name-list: an attr was OUT iff its name
happened to be hand-added to the set, IN otherwise. That is a tautology — it
records the names someone remembered, and the next port-private attr nobody adds
silently enters the cross-port contract. The decision is now an **explicit
classification** (`classifyPerTypeAttr` / `classifyTypeSubType`, uniform across
all four emitters — TS / C# / Java / Python; Kotlin reuses the JVM emitter). Each
per-type facet the emitter encounters resolves to **exactly one** of:

- **`INCLUDED`** — logical cross-port vocabulary (this is what the gate measures;
  MUST be identical in every port). Note "logical" is **not** "non-physical": the
  physical-DB attrs `column`/`dbColumnType`/`db.indexed`/`precision`/`scale`/
  `maxLength`/`unique` ARE logical here — they are the agreed cross-port
  *persistence* vocabulary (every port emits the same DDL contract from them). The
  real axis is **cross-port-CONTRACT vs port-PRIVATE-mechanism**, not
  abstract-vs-physical.
- An **`ExclusionReason`** — carved OUT of the contract *for a declared category*,
  never a bare name. The categories are: `NATIVE_BINDING` (factories / native type
  classes / ADR-0001 `@object` / ADR-0005 `@objectAdapter`), `STRUCTURAL_KEYWORD`
  (`isArray`/`isAbstract`/`extends`/`implements`/`isInterface`), `COMMON_ATTR_DUP`
  (`description` re-registered per-type — it lives in the `commonAttrs` block),
  `INHERITANCE_ANCHOR` (`metadata.base`), `PRESENTATION_ONLY` (the generic
  `view.*` controls).

The classification is **total** — there is no "unclassified" third state that
silently defaults to IN, so a port can never let an unreasoned facet through
undetected (`classifyPerTypeAttr` returns `INCLUDED` or a reason, and every port's
conformance runner asserts the classification is total and that each carve-out
carries its declared reason).

Why inclusion-by-default is **sound** rather than the old tautology: ADR-0023
seals each port's composed metamodel registry after the agreed-provider
bootstrap, so every registered `(type, subType, attr)` is, by construction,
deliberately-agreed metamodel vocabulary — there is no accidental registration to
silently let in. The classification's job is therefore to carve the small,
declared set of *agreed-but-port-private* facets OUT of that agreed vocabulary,
each with a reason; the cross-port byte-canonical is the backstop that a carve-out
hasn't gone stale (a dead rule would surface as a manifest diff).

### Base-vs-leaf rule (Wave 3b — one rule, applied identically in every port)

The manifest measures each `(type, subType)` row's **own attr set as physically
present on that registry row** — i.e. the *resolved* attrs at that row, NOT a
separately-computed `inheritsFrom` walk. The reference port (TS) registers the
full common attr set directly onto the base AND every concrete leaf (the
registration loops in `core-types.ts` do this), so each row is self-contained and
the manifest can read each row's own attrs uniformly. The JVM port resolves
`getChildRequirements()` (which includes inherited requirements) to the same
own-resolved set, de-duped by name. Consequence, made explicit so it is not read
as an inconsistency:

- A family whose shared attrs are registered on the base (e.g. `field.*`,
  `relationship.*`, `object.*`) shows those attrs on the **base row AND every leaf
  row** (each row carries its complete resolved set).
- A family whose attrs are declared only on the concrete subtype (e.g.
  `source.rdb`, `template.output`, the `origin.*` leaves) shows an **empty base
  row** and the attrs on the leaf.

Both are the *same* rule — "emit each row's resolved own-attrs" — applied to two
different (and legitimate) registration choices. `inheritsFrom` itself is NOT
surfaced (it remains the deferred facet below): the manifest deliberately does not
try to attribute an attr to its *declaring* level, only to report the resolved set
*present* at each level, which every port computes identically and the byte-gate
verifies.

### INCLUDED (v1 — the logical vocabulary, must be identical)

- Every registered `(type, subType)`.
- Each type's declared attrs as `{ name, valueType, isArray, required }`
  (`valueType: null` for polymorphic/untyped attrs; `isArray: true` for
  array-valued attrs — the scalar `valueType` plus the orthogonal array flag,
  NOT a conflated `stringarray` token, and NO `attr.stringarray` subtype).
- `commonAttrs` — the `registerCommonAttribute` / `registerCommonAttrs` set
  (the doc attrs: `aliases`, `deprecated`, `description`, `notes`, `replacedBy`,
  `seeAlso`, `title`).
- `defaultSubTypes` — the per-type designated default subType for bare-key YAML
  authoring sugar (`metadata` → `root`, `object` → `entity`).

### EXCLUDED — port-private mechanisms (carved out, each with a reason category)

Each bullet below is one of the `ExclusionReason` categories above. They are
**not** "things whose names we listed" — they are facets that are genuinely
per-port mechanism rather than cross-port contract, and the emitter classifies
them as such with a declared reason.

- **`NATIVE_BINDING`** — Node factory / `NodeConstructor` / Java `Class`; native
  type bindings (Java `DataTypes` value-class, TS native TS-type, EF/CLR types,
  the coarse `DataType` classification); **and the per-port type-binding facets
  `@object` + `@objectAdapter`** — `@object` is the ADR-0001 class-FQN type
  binding for OO ports (the Java runtime resolves an object's native class from
  this attr) and `@objectAdapter` is the ADR-0005 hybrid value-access seam. All
  are per-port BINDING mechanisms, not cross-port logical vocabulary. Java
  registers `@object`/`@objectAdapter` as per-type attrs on `object.*`
  (load-bearing runtime mechanisms read by the value-access representation, IO
  readers, and OMDB — kept registered in Java); the classification carves them out
  of the manifest (uniform across all four emitters; a no-op for TS/C#/Python,
  which never register them). See SP-G Unit 6b-finish.
- Codegen targets/options; the TS-only `D1` dialect and any other documented
  port-unique surface; ordering (we sort everything) — all out of scope.
- **`STRUCTURAL_KEYWORD`** (`isArray`, `isAbstract`, `extends`, `implements`,
  `isInterface`) — bare structural / OO-shape body keywords (peers of
  `name`/`children`), not attributes. Java additionally registers them as ordinary
  per-type attrs (inherited everywhere); the other ports do not. The
  classification carves them out of each type's `attrs` list (uniform across all
  four emitters; a no-op for TS/C#/Python). See SP-G analysis C-2/C-3.
- **`COMMON_ATTR_DUP`** (`description`) — `description` is a `commonAttr` (emitted
  in the `commonAttrs` block), not a per-type attribute. Java registers it
  per-type too (a duplicate); the classification carves out the per-type
  occurrence (it stays in `commonAttrs`). See SP-G analysis C-3.
- **`INHERITANCE_ANCHOR`** (`metadata.base`) — Java registers an internal abstract
  anchor (`metadata.base`) that all types inherit from; the other ports register
  only the concrete tree root (`metadata.root`). It is the not-universally-tracked
  `inheritsFrom` anchor this manifest already defers, so the `(metadata, base)`
  row is carved out. See SP-G analysis C-5.
- **`PRESENTATION_ONLY`** — the 11 generic `view.*` controls (`checkbox`, `date`,
  `dropdown`,
  `hidden`, `hotlink`, `month`, `number`, `password`, `radio`, `text`,
  `textarea`, `web`) — a TS-web-PRESENTATION facet, like the TS-only `D1`
  dialect. They have zero backend / codegen / render consumers; only the TS web
  client (`client/web/packages/{tanstack,angular}/src/`) + TS form codegen
  (`server/typescript/packages/codegen-ts/src/templates/field-meta.ts`) consume
  them. They stay **registered in TypeScript** (the loader must accept an
  authored `view.dropdown`) but are **deregistered in C# + Python** (dead vocab
  there) and **excluded from the manifest** by all four emitters. Only
  `view.base` + `view.currency` (the cross-port currency `@locale` wire
  contract) remain. See SP-G analysis B-2.

### EXCLUDED from v1 — deferred follow-ons (documented, not silent)

These were evaluated against the three "open boundary calls" in the design spec
and excluded because they are **not tracked identically on all five
registries**. They are intentional deferrals, to be revisited as a follow-on —
NOT silent omissions.

- **`allowedValues` / `default` on attr schemas.** TS, C#, and Python carry both
  on their `AttrSchema`. Java does **not**: in Java an attribute is modeled as a
  `ChildRequirement` (`expectedType="attr"`), which has no `allowedValues` /
  `default` fields. Including these would require a per-port-conditional manifest
  (forbidden) or a Java registry change beyond the scope of a detection gate.
  **Excluded from v1.**

- **`inheritsFrom` (the declared parent `type.subType`).** Only the Java
  `TypeDefinition` tracks a declared `parentType` / `parentSubType` on the
  registry. TS, C#, and Python do not expose a declared parent on the registry
  at all (subtype inheritance, where it exists, is resolved differently). Not
  universally tracked → **excluded from v1.**

- **`childRules` (structural child-type vocabulary).** TS / C# / Python model
  these as a clean `ChildRule { childType, childSubType, childName }` list. Java
  conflates **attrs, child-type rules, and placement/validation constraints**
  into a single `ChildRequirement` list (an attr is a `ChildRequirement` with
  `expectedType="attr"`; a child-type rule is one with `name="*"`; there are also
  placement/validation-constraint variants). Mapping Java's list to
  `{childType, childSubType}` without guessing which requirements are "pure
  structural child rules" is non-trivial. Per the design spec's explicit
  guidance, **childRules is scoped out of v1** and is the primary candidate for a
  follow-on once the Java representation is reconciled.

## Fix-at-source on divergence

When a port's emitter first runs, it may NOT match the canonical — **that is the
point** (this is a drift-finding gate). Each mismatch is a real registry
divergence:

- **Fix the diverging port's registration** to match the cross-port contract —
  do NOT loosen the canonical to accommodate drift.
- The **only** exception: if a divergence reveals that **TS itself is wrong**
  versus the documented contract (TS is the reference, but it is not infallible),
  fix TS, regenerate `expected-registry.json`, and re-verify every port. Note the
  escalation.
- Never make the manifest per-port-conditional. A facet that cannot be emitted
  identically by all five ports is excluded from v1 and documented here (see
  above), never fudged.

## Per-port status

| Port | Status | Runner | Runs in CI via |
|---|---|---|---|
| TypeScript | **live + green** (reference emitter; produces the canonical) | `packages/metadata/test/registry-conformance.test.ts` | `conformance` job, `typescript` matrix leg (scoped `bun test`) |
| C# | **live + green** (byte-identical) | `MetaObjects.Conformance.Tests/RegistryManifestConformanceTests.cs` | `conformance` job, `csharp` matrix leg (whole `MetaObjects.Conformance.Tests` project) |
| Python | **live + green** (byte-identical) | `tests/conformance/test_registry_conformance.py` | `conformance` job, `python` matrix leg (whole `tests/conformance` dir) |
| Java | **live + green** (byte-identical; reconciled SP-G Units 4-7, gate re-enabled Unit 8) | `metadata/src/test/java/com/metaobjects/registry/RegistryManifestConformanceTest.java` | `conformance` job, `java` matrix leg (in the metadata `-Dtest=` list) |
| Kotlin | **live + green** (byte-identical; composes the metamodel provider set) | `codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/RegistryManifestConformanceTest.kt` | `conformance-kotlin` job (in the codegen-kotlin `-Dtest=` list) |

All five ports now genuinely run the gate on every CI build (`.github/workflows/conformance.yml`). TS / C# / Python were live from the start; Java + Kotlin were re-enabled in SP-G Unit 8 after the Java metamodel-vocabulary reconciliation (Units 4-7) landed (see the **divergence analysis**:
[`docs/superpowers/specs/2026-06-02-sp-g-java-registry-divergence-analysis.md`](../../docs/superpowers/specs/2026-06-02-sp-g-java-registry-divergence-analysis.md) and the
[reconciliation plan](../../docs/superpowers/plans/2026-06-02-sp-g-java-reconciliation-plan.md)).

**Why the Java + Kotlin runners compose from a defined provider set.** Both JVM
runners build their registry from the explicit metamodel provider set
(`RegistryManifest.composeMetamodelRegistry()` — mirroring the TS reference's
`composeRegistry(coreProviders)`), NOT from the process-global
`MetaDataRegistry.getInstance()` singleton. The metadata module's classpath holds
only the metamodel providers, but a downstream module that also runs the gate
(`codegen-kotlin`) has the `om` + `codegen-base` modules on its test classpath —
whose SPI providers register an extra `object.managed` subtype and ~22
codegen-tooling attrs (`ai*` / `json*` / `has*`, self-registered by the doc
generators `MetaDataAIDocumentationGenerator` / `MetaDataFileJsonSchemaGenerator`).
Those are per-port codegen tooling, NOT the cross-port logical metamodel
vocabulary the gate measures (the same category as the EXCLUDED native type
bindings / codegen targets). Composing from the defined provider set makes every
module's runner measure the identical vocabulary — the gate stays meaningful (it
still catches a real attr/subtype divergence in any metamodel provider) while
being immune to classpath pollution.

Detail per port:

- **TypeScript** — reference emitter; green (produces the canonical).
- **C#** — green, byte-identical.
- **Python** — green, byte-identical (`emit_registry_manifest` in
  `server/python/src/metaobjects/registry_manifest.py`; runner
  `tests/conformance/test_registry_conformance.py`). Running the gate surfaced
  targeted drift (now reconciled at source): the attr value-type / `attr.*`
  subtype spelled `stringArray` instead of the cross-port `stringarray`; missing
  field attrs `db.indexed` / `readOnly` (and `currency` on `field.currency`);
  missing subtypes `field.base|byte|short`, `object.base`, `template.base`, and
  9 `view.*` control kinds; missing attrs `discriminator`/`discriminatorValue`
  on `object.*`, the M:N slim vocabulary `cardinality`/`through`/
  `sourceRefField`/`symmetric`/`objectRef` (FR-018 — the removed `joinEntity`/
  `joinFields` are no longer in the canonical) on
  `relationship.*`, `parameterRef` on `source.rdb`, `unique` on
  `identity.secondary`, `filterable` on `layout.dataGrid`, `locale` on
  `view.currency`; and `template.*` `payloadRef` declared optional + carried on
  `template.base` (the shared attrs now live only on the concrete subtypes with
  `payloadRef` required, matching TS — the manual prompt-payloadRef check was
  removed in favor of the generic required-attr schema check). Two dead,
  never-registered constants (`RELATIONSHIP_ATTR_FK_FIELD` / `_PARENT_FIELD`)
  were removed. No structural (Java-class) divergence — Python uses the same attr
  vocabulary and registry model.
- **Java + Kotlin (shared JVM emitter)** — emitter (`RegistryManifest.emit`,
  `metadata` module) + runners (`RegistryManifestConformanceTest` in `metadata`
  and `codegen-kotlin`) are **live + green** (both re-enabled in SP-G Unit 8;
  each composes from the defined metamodel provider set — see "Why the Java +
  Kotlin runners compose from a defined provider set" above). The historical
  divergence inventory below records what the gate surfaced and how it was
  reconciled. SP-G Phase 1 (Units 2-3) settled three of the divergences cross-port via the
  uniform emitter exclusions documented in "EXCLUDED" above (no Java behavior
  change): the structural keywords `isArray`/`isAbstract` + the `description`
  per-type duplicate are filtered from the `attrs` list, the `metadata.base`
  anchor row is skipped, and the 11 generic `view.*` controls are cut (Java
  never registered them). The REMAINING (Phase 2) divergence between Java's
  registry and the cross-port logical vocabulary that TS, C#, and Python agree
  on: Java carries a parallel physical-DB attr vocabulary
  (`dbType`/`dbIndex`/`dbLength`/`dbNullable`/`dbForeignKey`/`dbPrecision`/
  `dbScale`/`dbUnique`/`previousName`/`dbSequenceName`/`dbIndexName`/
  `dbTablespace`) instead of `column`/`db.indexed`/`dbColumnType` +
  `maxLength`/`precision`/`scale`/`unique`; is missing the logical field attrs
  `autoSet`/`filterable`/`sortable`/`sortableDefaultOrder`/`readOnly`/`storage`;
  carries Java-specific feature attrs the contract has no peer for
  (`minLength`/`pattern`/`maxValue`/`minValue`/`format`/`dateFormat`/`maxDate`/
  `minDate`/`defaultView`, validator `msg`/`mask`/`maxSize`/`minSize`); models
  `object.*` with Java OO attrs (`extends`/`implements`/`object`/`objectAdapter`/
  `isInterface`/`value*`/`data*`) instead of `discriminator`/`discriminatorValue`.
  (The structural
  keyword / `description` / `metadata.base` / generic `view.*` divergences were
  settled in Phase 1 — see above.) Reconciling this at source means rewriting Java's
  metamodel attribute layer to the cross-port vocabulary — a change that ripples
  through the loader's validation, OMDB, `codegen-spring`, and `codegen-kotlin`
  (all consume the current Java attrs). It is tracked as a dedicated follow-on,
  NOT a silent omission, and the canonical is **not** edited (it is correct).
  **Update (Phase 2 complete):** every divergence above has since been reconciled
  unit-by-unit — the final piece, the physical `db*` vocabulary, was converged in
  SP-G Unit 7 (the logical-equivalent attrs `dbType`/`dbIndex`/`dbLength`/
  `dbNullable`/`dbPrecision`/`dbScale`/`dbUnique` mapped onto the cross-port
  `dbColumnType`/`db.indexed`/`maxLength`/required-ness/`precision`/`scale`/`unique`
  + owned-object `@storage="jsonb"`, with consumers in `omdb` + `codegen-mustache`
  migrated; the DDL/migration-only remnants `dbForeignKey`/`previousName`/
  `dbIndexName`/`dbSequenceName`/`dbTablespace` dropped as dead under ADR-0015).
  The Java manifest now byte-matches the canonical (residual EMPTY); SP-G Unit 8
  re-enabled the gate (dropped `@Ignore`/`@Disabled`), constrained both JVM
  runners to the defined metamodel provider set, and wired both into CI.

## Regenerating the canonical

The canonical is generated from the TS reference emitter. After an intended TS
registry change, regenerate and reconcile the other ports:

```ts
import { composeRegistry, coreProviders, emitRegistryManifest } from "@metaobjectsdev/metadata";
process.stdout.write(emitRegistryManifest(composeRegistry(coreProviders)));
```

(write the output to `fixtures/registry-conformance/expected-registry.json`),
then run every port's registry-conformance runner to confirm they still
byte-match — reconciling any newly-surfaced divergence at the source.

## Untested-vocabulary coverage report (`coverage-report.json`)

The registry-conformance gate above proves the vocabulary is **identical across
ports**. It does NOT prove the vocabulary is **exercised** at all — a registered
`(type, subType)` or attr that no fixture ever uses is only caught incidentally,
which is exactly the meta-gap that let the SP-C drift hide for weeks (a drifted
member was invisible because no behavioral fixture happened to touch it).

The coverage report closes that gap. It cross-references the registered
vocabulary (this manifest) against the conformance **fixture corpora** and
surfaces every registered `(type, subType)` — and each declared attr on an
exercised subtype — that NO fixture exercises.

- **Module:** `server/typescript/packages/metadata/src/registry-coverage.ts`
  (pure + testable: `computeCoverage(manifest, corpusRoots)`).
- **Test:** `server/typescript/packages/metadata/test/registry-coverage.test.ts`
  — scans `fixtures/conformance/` (the primary vocabulary exerciser) unioned
  with the render / persistence / api-contract / output-prompt / extract corpora
  (so a member exercised in any corpus is not falsely flagged untested). A
  fixture node keyed `"<type>.<subType>"` exercises that subtype; an `@attr` (or
  reserved bare key) set on it exercises that attr; `children` are walked
  recursively.
- **Snapshot:** [`coverage-report.json`](./coverage-report.json) — a sorted,
  deterministic, committed snapshot of the untested sets + counts.

**Monotonic ratchet — hard-fails on a coverage REGRESSION (Wave 4a).** The
untested set today is a legitimate **pre-existing backlog** — many subtypes
(`view.*` controls, the `validator.*` family, the abstract `*.base` anchors, the
`attr.*` value-type subtypes) and many attrs are not yet exercised by a fixture.
Hard-failing CI on that whole backlog would block everything for no gain. So the
committed `coverage-report.json` is treated as a **baseline**, not an exact
expectation, and the test enforces a **one-way ratchet**: coverage may improve
freely but must never regress. The build hard-fails when

- a registered `(type, subType)` that the baseline had **exercised** becomes
  unexercised (a NEW entry in `untestedSubTypes`), or
- an attr on an exercised subtype that the baseline had **exercised** becomes
  unexercised (a NEW entry in that key's `untestedAttrs`).

Adding an exercising fixture (an item LEAVES an untested set) is an improvement
and is always allowed — the test prints a hint suggesting you tighten the
baseline so a future regression of the newly-exercised item is caught too.

The comparison is **set-based, not count-based**: an integer-only check would let
a regression hide behind a simultaneous improvement (one item newly exercised, a
different one regressing, with the net count unchanged). The ratchet compares the
untested **sets** directly, so each individual regression is named in the failure
message (which item regressed + how to fix it). Implemented by `checkRatchet` /
`formatRatchetFailure` in
`server/typescript/packages/metadata/src/registry-coverage.ts`; a self-contained
negative test feeds a synthetic regression and asserts the ratchet bites, so the
gate is provably live (not vacuous). It runs in ONE port (TS reference) — the
coverage measurement is over the shared canonical vocabulary, so the ratchet is
not fanned into all five runners.

When coverage IMPROVES (an item is newly exercised; the baseline can be made
stricter), or a member is legitimately removed from the vocabulary, regenerate
the baseline in one step:

```
cd server/typescript
MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test packages/metadata/test/registry-coverage.test.ts
```

**Fully burn down later.** Once the backlog empties (the untested-subtype set
goes to zero), this can be tightened further to hard-fail on ANY untested subtype
— forcing a fixture for every vocabulary member, not merely forbidding
regressions.

## Per-subtype write-round-trip matrix (SP-H)

The registry-conformance gate (above) proves the field-subtype vocabulary is
**identical across ports**, and the metamodel `fixtures/conformance/` corpus
proves each subtype **loads**. SP-H closed the remaining axis: every concrete
`field.*` subtype must also **write+read round-trip through each port's
runtime/ORM** — not just be seeded by raw SQL and read back. That gate lives in
the persistence corpus, not here, but it is recorded here so a future subtype
added without a write-round-trip is visible:

| `field.*` subtype | metamodel corpus | persistence write-round-trip | codegen |
|---|:--:|:--:|:--:|
| string    | ✅ | ✅ | ✅ |
| int       | ✅ | ✅ | ✅ |
| long      | ✅ | ✅ | ✅ |
| double    | ✅ | ✅ | ✅ |
| float     | ✅ | ✅ | ✅ |
| decimal   | ✅ | ✅ | ✅ |
| boolean   | ✅ | ✅ | ✅ |
| date      | ✅ | ✅ | ✅ |
| time      | ✅ | ✅ | ✅ |
| timestamp | ✅ | ✅ | ✅ |
| currency  | ✅ | ✅ | ✅ |
| enum      | ✅ | ✅ | ✅ |
| uuid      | ✅ | ✅ | ✅ |
| object    | ✅ | ✅ | ✅ |

- **persistence write-round-trip** = the `op: roundtrip` scenario type in
  `fixtures/persistence-conformance/queries/roundtrip-all-types.yaml`: its
  `AllTypes` entity carries one field of every persistable subtype, INSERTed
  through each port's runtime/ORM write codec (NOT raw SQL) then read back and
  asserted against the wire-normalized `expect`. Run on all five ports
  (TS / C# / Java / Kotlin / Python) against Testcontainers Postgres.
- **codegen** = each port emits the `AllTypes` entity + its `all_types` table
  (the committed TS-produced `canonical/schema.postgres.sql`), and the
  api-contract corpus boots each port's generated artifact.

`field.byte` / `field.short` / `field.class` are **absent by design** — they
were cut as non-functional registration-only stubs (byte/short in `29057ad5`,
class in SP-H), so the matrix tracks only genuinely-supported subtypes. Adding a
new persistable `field.*` subtype means adding a column to `AllTypes` (and a row
here) so the write gate covers it from day one.
