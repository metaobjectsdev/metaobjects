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

## In / out boundary

The guiding rule: **include a facet only if it is part of the cross-port logical
contract AND all five ports can emit it identically.** A smaller airtight
manifest beats a bigger flaky one — when unsure, exclude from v1 and document the
deferral.

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

### EXCLUDED — legitimately per-port / physical (never in scope)

- Node factory / `NodeConstructor` / Java `Class` — per-port physical wiring.
- Native type bindings (Java `DataTypes` value-class, TS native TS-type, EF/CLR
  types, the coarse `DataType` classification) — physical, per-port.
- **The per-port type-binding facets `@object` + `@objectAdapter`** — `@object`
  is the ADR-0001 class-FQN type binding for OO ports (the Java runtime resolves
  an object's native class from this attr) and `@objectAdapter` is the ADR-0005
  hybrid value-access seam. These are the same category as the native type
  bindings above — legitimate per-port BINDING mechanisms, not cross-port logical
  vocabulary. Java registers them as per-type attrs on `object.*` (load-bearing
  runtime mechanisms read by the value-access representation, IO readers, and
  OMDB — kept registered in Java); the emitter filters them by name from each
  type's `attrs` list (uniform across all four emitters; a no-op for
  TS/C#/Python, which never register them). See SP-G Unit 6b-finish.
- Codegen targets/options.
- The TS-only `D1` dialect and any other documented port-unique surface.
- Ordering (we sort everything).
- **Structural keywords as per-type attrs (`isArray`, `isAbstract`)** — these are
  bare structural body keywords (peers of `name`/`extends`/`children`), not
  attributes. Java additionally registers them as ordinary per-type attrs
  (inherited everywhere); the other ports do not. The emitter filters them by
  name from each type's `attrs` list (uniform across all four emitters; a no-op
  for TS/C#/Python). See SP-G analysis C-2/C-3.
- **`description` as a per-type attr** — `description` is a `commonAttr` (emitted
  in the `commonAttrs` block), not a per-type attribute. Java registers it
  per-type too (a duplicate); the emitter filters the per-type occurrence by
  name (it stays in `commonAttrs`). See SP-G analysis C-3.
- **The `metadata.base` inheritance anchor** — Java registers an internal
  abstract anchor (`metadata.base`) that all types inherit from; the other ports
  register only the concrete tree root (`metadata.root`). It is the
  not-universally-tracked `inheritsFrom` anchor this manifest already defers, so
  the `(metadata, base)` row is skipped by the emitter. See SP-G analysis C-5.
- **The 11 generic `view.*` controls** (`checkbox`, `date`, `dropdown`,
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
| Java | **gated (`@Ignore`)** — Phase-2 vocabulary divergence | `metadata/src/test/java/com/metaobjects/registry/RegistryManifestConformanceTest.java` | n/a — intentionally NOT in the scoped `-Dtest=` list while gated |
| Kotlin | **gated (`@Disabled`)** — shares the Java JVM registry | `codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/RegistryManifestConformanceTest.kt` | n/a — intentionally NOT in the scoped `-Dtest=` list while gated |

The three live ports (TS / C# / Python) genuinely run on every CI build (`.github/workflows/conformance.yml`, `conformance` job). The Java + Kotlin runners are wired and compile, but their assertions are `@Ignore`/`@Disabled` pending the Java metamodel-vocabulary reconciliation (tracked as a dedicated follow-on; see the **divergence analysis**:
[`docs/superpowers/specs/2026-06-02-sp-g-java-registry-divergence-analysis.md`](../../docs/superpowers/specs/2026-06-02-sp-g-java-registry-divergence-analysis.md) and the
[reconciliation plan](../../docs/superpowers/plans/2026-06-02-sp-g-java-reconciliation-plan.md)). They are left out of the Java/Kotlin scoped `-Dtest=` lists so they neither run nor error — re-add them (and drop the annotation) once the reconciliation lands.

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
- **Java + Kotlin (shared JVM registry)** — emitter (`RegistryManifest.emit`,
  `metadata` module) + runners (`RegistryManifestConformanceTest` in `metadata`
  and `codegen-kotlin`) are wired and functional, but the assertions remain
  **`@Ignore`/`@Disabled` — ESCALATED** (Phase-2 divergences below remain).
  SP-G Phase 1 (Units 2-3) settled three of the divergences cross-port via the
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
  `isInterface`/`value*`/`data*`) instead of `discriminator`/`discriminatorValue`;
  and has subtype gaps (missing `field.byte`, `field.short`). (The structural
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
  The Java manifest now byte-matches the canonical (residual EMPTY); the gate stays
  `@Ignore`/`@Disabled` only until SP-G Unit 8 flips it atomically with CI wiring.

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

**Report, not hard-fail (by design).** The untested set today is a legitimate
**pre-existing backlog** — many subtypes (`view.*` controls, `field.byte` /
`field.short`, the `validator.*` family, the abstract `*.base` anchors, the
`attr.*` value-type subtypes) and many attrs are not yet exercised by a fixture.
Hard-failing CI on that backlog would block everything for no gain. So the test
ALWAYS prints the coverage summary AND asserts the committed snapshot is
unchanged — a **newly** untested subtype shows up as a visible git diff (a
regression to investigate); a newly exercised one is progress. Regenerate the
snapshot after an intended vocabulary/fixture change:

```
cd server/typescript
MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test packages/metadata/test/registry-coverage.test.ts
```

**Ratchet later.** Once the backlog is burned down (the untested-subtype set
empties), this can be tightened to hard-fail on any untested subtype — turning
the report into a gate that forces a fixture for every new vocabulary member.
