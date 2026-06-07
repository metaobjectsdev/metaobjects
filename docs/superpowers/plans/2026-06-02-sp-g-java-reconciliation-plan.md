# SP-G Java Registry Reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Java (and shared-JVM Kotlin) metamodel registry conform to the cross-port SP-G canonical so `RegistryManifestConformanceTest` passes byte-identically in all five ports — by first settling three manifest-schema questions cross-port (near-zero Java cost), then reconciling the genuine Java registry drift, then re-enabling the gated assertions.

**Architecture:** Two phases. **Phase 1 (cross-port, cheap)** changes the manifest schema/emitters + canonical only — no Java behavior change — and dissolves the largest swath of "divergence" (array modeling, structural-keyword filtering, view-control scope). **Phase 2 (Java, real)** reconciles Java's registration to the now-settled canonical, conformance-green at every step, touching `metadata` (+ loader validation), `omdb`, `codegen-spring`, `codegen-kotlin`. **Phase 3** re-enables the gate + wires CI + docs.

**Tech Stack:** TS/C#/Python/Java registry emitters (`registry-manifest.*`), the canonical `fixtures/registry-conformance/expected-registry.json`, Java `MetaDataRegistry` + per-type registration classes, JUnit (`metadata`, `codegen-kotlin`), the OMDB persistence layer + Spring/Kotlin codegen.

**Spec / source of truth:** `docs/superpowers/specs/2026-06-02-sp-g-java-registry-divergence-analysis.md` (the A/B/C/D bucket classification). The **per-unit acceptance test is the byte-match of the relevant manifest slice to the canonical** — the gate test IS the precise spec; iterate against it.

**Settled design decisions (from the 2026-06-02 review):**
1. **C-1 arrays:** adopt `{valueType, isArray}` in the manifest schema; retire the redundant `attr.stringarray` subtype cross-port (array attrs become `string` + `@isArray`, matching Java's orthogonal model).
2. **B-2 view.\*:** the 11 generic view controls are TS-web-presentation-only (zero backend/codegen/render consumers, zero conformance coverage). **Cut from the canonical** — exclude from the manifest as a documented TS-presentation facet (like D1), deregister from C#/Python (dead vocab there), **keep registered in TS** (the web client + TS form codegen require it for authoring). Keep `view.base` + `view.currency` (cross-port currency `@locale` wire contract).
3. **B-1 byte/short:** keep in the contract; **Java adds** `field.byte` / `field.short`.
4. **B-3 msg / C-3 defaultView:** Java-only, no cross-port consumer → **drop in Java** (verify no consumer first).

**Worktree:** the SP-G work currently lives in `<repo-root>/.claude/worktrees/sp-g-registry-conformance`. This plan may execute either as a continuation of that branch (if SP-G has not yet merged) or in a fresh worktree off the merged main. Either way, Phase 1 re-touches the SP-G emitters + canonical.

---

## Phase 1 — Cross-port manifest-schema settling (no Java behavior change)

These three units change the manifest contract + the four emitters + the canonical. TS/C#/Python registry *behavior* is largely unchanged except the `attr.stringarray` retirement (Unit 1). Java's *emitter output* converges toward the canonical on these facets without touching Java's loader/codegen.

### Unit 1: Array modeling — `{valueType, isArray}` + retire `attr.stringarray` (C-1)

**Files:**
- Modify: `server/typescript/packages/metadata/src/registry-manifest.ts` (emit `isArray`; decompose array attrs)
- Modify: `server/csharp/MetaObjects/RegistryManifest.cs`, `server/python/src/metaobjects/registry_manifest.py`, `server/java/metadata/src/main/java/com/metaobjects/registry/RegistryManifest.java` (same shape)
- Modify: TS/C#/Python attr registration to retire the `attr.stringarray` subtype — array attrs (`values`, `fields`, `aliases`, `seeAlso`, `joinFields`, `columns`, `requiredTags`, `requiredSlots`) become a `string` attr carrying an array flag (mirror Java's `StringAttribute + @isArray`; see `AttributeTypesMetaDataProvider.java:55`, `EnumField.java:165`)
- Regenerate: `fixtures/registry-conformance/expected-registry.json`
- Modify: `fixtures/registry-conformance/README.md` (schema section: attr is now `{name, valueType, isArray, required}`)
- Test: the four ports' registry-conformance tests (`server/typescript/packages/metadata/test/registry-conformance.test.ts` + the C#/Python/Java equivalents)

- [ ] **Step 1 — Decide the manifest attr shape + write it into the README schema.** Attr object becomes `{ "name", "valueType", "isArray", "required" }` (key order fixed; `isArray` after `valueType`). `valueType` is the SCALAR type (`string`/`int`/`boolean`/…); `isArray: true` replaces the old `valueType: "stringarray"`. Polymorphic attr (`default`) stays `valueType: null, isArray: false`. Update the README "Manifest schema" + "Serialization contract" sections.
- [ ] **Step 2 — TS emitter: emit `isArray`, decompose `stringarray`.** In `registry-manifest.ts`, when an attr's registered value-type is the array string type, emit `valueType: "string", isArray: true`; otherwise `isArray: false`. Keep the ordinal sort + key order. (Do this BEFORE the registry retirement so you can diff the manifest shape change in isolation.)
- [ ] **Step 3 — Retire the `attr.stringarray` subtype in TS registration.** Remove the `attr.stringarray` subtype registration; re-register the array-valued attrs (`@values`/`@fields`/`@aliases`/`@seeAlso`/`@joinFields`/`@columns`/`@requiredTags`/`@requiredSlots`) as `string` attrs with the array flag the TS loader already understands (`@isArray`). Confirm the loader still parses these attrs as JSON arrays (driven by the array flag, not the retired subtype). Run the TS metadata + conformance suite — fix any fixture/parse fallout. (No `attr.stringarray` row should remain in the manifest.)
- [ ] **Step 4 — Regenerate the canonical from TS + update the TS test.** Regenerate `expected-registry.json`; confirm the `attr.stringarray` subtype row is gone and every former-`stringarray` attr now shows `valueType: "string", isArray: true`. TS test green.
- [ ] **Step 5 — C# + Python: mirror the emitter + retire `attr.stringarray`.** Same emitter shape (ordinal sort, `isArray` key). Retire the C#/Python `attr.stringarray` subtype + re-register the array attrs as `string` + array-flag (this REVERSES the Unit-4 `stringArray`→`stringarray` work — the subtype goes away entirely). Each port's registry-conformance test green against the regenerated canonical; broader conformance suites green.
- [ ] **Step 6 — Java emitter: emit `isArray` from `.asArray()`.** In Java's `RegistryManifest.java`, emit `valueType: "string", isArray: true` for `StringAttribute` requirements marked array (`@isArray` / `.asArray()`); `isArray: false` otherwise. Do NOT change Java registration here. Re-run the Java emitter (you may temporarily un-skip the Java test locally) and confirm the array facet now matches the canonical (the `enum.values`/`dataGrid.columns`/`identity.fields` value-type + missing-subtype rows from analysis C-1 are resolved). Re-skip if other facets still diverge.
- [ ] **Step 7 — Review + simplify gate, then commit.** Spec-compliance review (the retirement preserved array-attr parsing in all three ports; no `stringarray` subtype anywhere; canonical regenerated not hand-edited) + code-quality/simplifier on the four emitters. Commit: `feat(conformance): SP-G Phase1 Unit1 — manifest {valueType,isArray} + retire attr.stringarray cross-port`

### Unit 2: Structural-keyword + anchor filtering (C-2, C-3, C-5)

**Files:**
- Modify: all four `registry-manifest.*` emitters (shared exclusion filter)
- Modify: `fixtures/registry-conformance/README.md` (EXCLUDED list: `isArray`, `isAbstract`, `description` as per-type attrs; `metadata.base` anchor)
- Regenerate: `fixtures/registry-conformance/expected-registry.json` (TS/C#/Python output should be unchanged by this — only Java's emitter currently emits these; verify)
- Test: the four registry-conformance tests

- [ ] **Step 1 — Add the structural-keyword attr filter to all four emitters.** Exclude attrs named `isArray`, `isAbstract`, and `description` from the per-type `attrs` list (these are bare structural keywords / a commonAttr, not per-type attrs — see analysis C-2/C-3). Use named constants. TS/C#/Python don't register these as per-type attrs, so their output is unchanged; Java registers them on `metadata.base`/`field.base` (`MetaData.java:152-153`, `MetaField.java:120/168`) and inherits them everywhere — the filter makes Java's emitter drop them. (`description` stays in `commonAttrs`, which Java already emits byte-identically.)
- [ ] **Step 2 — Exclude the `metadata.base` anchor (C-5).** Skip the `metadata.base` `(type, subType)` from the manifest (it is Java's internal inheritance anchor; other ports register only `metadata.root`). Document in the README EXCLUDED list as a per-port inheritance anchor (the deferred `inheritsFrom` facet).
- [ ] **Step 3 — Regenerate + assert no TS/C#/Python change.** Regenerate the canonical from TS; confirm it is byte-unchanged from Unit 1's output (these filters only affect Java's emitter). C#/Python tests green. Confirm Java's emitter (local un-skip) now drops the `isArray`/`isAbstract`/`description` per-type rows + the `metadata.base` row.
- [ ] **Step 4 — Review + simplify gate, then commit.** Confirm the filter is a documented, principled exclusion (not a fudge to hide a real divergence) + applied uniformly across the four emitters. Commit: `feat(conformance): SP-G Phase1 Unit2 — exclude structural keywords + metadata.base anchor from manifest`

### Unit 3: Cut generic `view.*` controls from the canonical (B-2)

**Files:**
- Modify: all four `registry-manifest.*` emitters (exclude the 11 generic view-control subtypes)
- Modify: `server/csharp/MetaObjects/Presentation/View/ViewConstants.cs`, `server/python/src/metaobjects/meta/presentation/view/view_constants.py` (deregister the 11 controls — dead vocab there)
- Keep: `server/typescript/packages/metadata/src/presentation/view/view-constants.ts` (TS web client + form codegen consume them — DO NOT deregister; verify the dependency in `client/web/packages/{tanstack,angular}/src/` + `server/typescript/packages/codegen-ts/src/templates/field-meta.ts`)
- Modify: `fixtures/registry-conformance/README.md` (EXCLUDED list: generic `view.*` controls as a TS-web-presentation facet, like D1)
- Regenerate: `fixtures/registry-conformance/expected-registry.json` (drops the 11 controls; keeps `view.base` + `view.currency`)
- Test: the four registry-conformance tests

- [ ] **Step 1 — Verify the TS view-control dependency before touching anything.** Confirm (grep `client/web/packages/`, `codegen-ts/src/templates/field-meta.ts`) that TS authoring/rendering genuinely needs the 11 control subtypes registered (the loader must accept an authored `view.dropdown` child). Record the finding. If — contrary to the investigation — nothing needs them in TS either, prefer full cross-port deregistration; otherwise keep TS registration and exclude-in-manifest.
- [ ] **Step 2 — Exclude the 11 generic view controls from all four emitters.** Filter the subtypes `checkbox`, `date`, `dropdown`, `hidden`, `hotlink`, `month`, `number`, `password`, `radio`, `text`, `textarea`, `web` under type `view` from the manifest. Keep `view.base` + `view.currency`. Document in the README EXCLUDED list with the rationale (TS-web-presentation-only; zero backend consumers).
- [ ] **Step 3 — Deregister the 11 controls in C# + Python.** Remove them from `ViewConstants.cs` `VIEW_SUBTYPES` + `view_constants.py` (and their constants) — they are dead vocab in those backends. Keep `view.base` + `view.currency`. Run the C#/Python conformance suites green (confirm no fixture authored a generic view control — if one does, that fixture is itself TS-presentation and should be reviewed).
- [ ] **Step 4 — Regenerate canonical + assert.** Regenerate from TS; confirm the 11 control rows are gone and `view.base`/`view.currency` remain. All four registry-conformance tests green.
- [ ] **Step 5 — Review + simplify gate, then commit.** Confirm: TS still registers + consumes the controls; C#/Python cleaned; manifest exclusion documented; canonical regenerated. Commit: `feat(conformance): SP-G Phase1 Unit3 — cut generic view.* controls from canonical (TS-presentation facet)`

**End of Phase 1:** the canonical reflects the settled cross-port logical vocabulary. Re-running the Java emitter (local un-skip) at this point should show ONLY the genuine Java drift remaining (buckets A + C-4 + D-1). Capture that residual diff — it is Phase 2's precise worklist.

---

## Phase 2 — Java registry reconciliation (gated, conformance-green throughout)

Each unit fixes a slice of Java's registration to match the canonical, keeping the existing Java conformance corpora (`fixtures/conformance/`) green and updating downstream consumers (`omdb`, `codegen-spring`, `codegen-kotlin`) as needed. Keep `RegistryManifestConformanceTest` `@Disabled` until Phase 3 — but after each unit, locally un-skip to confirm the targeted rows now match (then re-skip).

### Unit 4: Java logical-vocabulary registration (A-2, A-4, B-1)

**Files (Java `metadata` module registration classes + loader validation + consumers):**
- Modify: field subtype registration (`MetaField` + the field subclasses) — add `readOnly` (FR-013), `autoSet`, `filterable`, `sortable`, `sortableDefaultOrder`, `storage`
- Modify: object subtypes (`MetaObject` family) — add `discriminator`, `discriminatorValue` (FR-014)
- Modify: `Source*` (`source.rdb`) — add `parameterRef` (FR-015)
- Modify: `MetaRelationship` — add `joinEntity` (string), `joinFields` (string+isArray); drop legacy `referencedBy` (`MetaRelationship.java:43`) after confirming codegen no longer needs it
- Modify: `SecondaryIdentity` — add `unique` (boolean)
- Create: `field.byte` / `field.short` subtype classes (`ByteField`/`ShortField`) + register them
- Modify: `codegen-spring` + `codegen-kotlin` consumers that referenced `referencedBy` / expect these attrs

- [ ] **Step 1 — Write/extend the gate-slice assertion.** Before changing registration, in the (still-disabled) Java emitter run, confirm these specific rows are the divergence: missing `readOnly`/`autoSet`/`filterable`/`sortable`/`sortableDefaultOrder`/`storage` on `field.*`; missing `discriminator`/`discriminatorValue` on `object.*`; missing `parameterRef` on `source.rdb`; `referencedBy` extra + `joinEntity`/`joinFields` missing on `relationship.*`; missing `unique` on `identity.secondary`; missing `field.byte`/`field.short`. This is the unit's checklist.
- [ ] **Step 2 — Register the missing attrs (TDD per family).** For each family: add the `optionalAttribute` registration with the canonical's value-type, run the `metadata` conformance suite, fix fallout. The FR-013/014/015 error codes already exist in `ErrorCode.java` — wire the attr registration so the existing validation fires. Use the FR specs (`2026-05-28-fr-013…`, `…fr-014…`, `…fr-015…`) for exact attr semantics.
- [ ] **Step 3 — Relationship join vocab + `referencedBy` (NOT a like-for-like swap).** Register `joinEntity`/`joinFields` (M:N junction modeling) — Java lacks any M:N modeling today, so this is a clean drift fix. **But `referencedBy` is a DIFFERENT concept** (the own FK-field name implementing an N:1/1:1 association — `MetaRelationship.java:42-43`, consumed by `codegen-mustache HelperRegistry.isForeignKeyField:309-334`), NOT the inverse of `joinEntity`. The canonical expresses `referencedBy`'s concern via `identity.reference` (`@references`), which Java already has. So: do NOT hard-drop `referencedBy` as part of adopting the join vocab — first reroute Java's FK-field detection onto `identity.reference` (it already falls back to `Id`-suffix inference, so it degrades rather than breaks); only then deregister `referencedBy`. If rerouting is out of scope for this unit, **deprecate `referencedBy` rather than dropping it**, and split the FK-detection migration into its own task. Keep persistence + api-contract conformance green.
- [ ] **Step 3a — (pending naming decision) `joinEntity` → `through` rename.** `joinEntity`/`joinFields` are physical/SQL-flavored names for the M:N **through/junction entity** + its two FK fields. ORM precedent (Rails `has_many through:`, EF `UsingEntity`, UML association-class) favors a relationship-semantic name. If the rename is approved, it is a **breaking cross-port vocabulary change** (TS/C#/Python + the canonical + this Java work) — do it in Phase 1 (alongside the other manifest-vocabulary settling) BEFORE Java adopts the attr, so Java registers the final name. If deferred, Java registers `joinEntity` to match the current canonical and the rename becomes a separate cross-port change later.
- [ ] **Step 4 — Add `field.byte` / `field.short`.** Mirror an existing narrow-int field subclass; register; ensure codegen (Spring + Kotlin) + OMDB map them to the right native/DB types. Persistence conformance green.
- [ ] **Step 5 — Local un-skip → confirm these rows match → re-skip. Review + simplify gate. Commit.** `feat(metadata): SP-G Phase2 Unit4 — register FR-013/014/015 + join + filter/sort/storage + byte/short (Java)`

### Unit 5: Java validator vocabulary (A-1, B-3)

**Files:** `MetaValidator` + `RegexValidator` / `LengthValidator` / `NumericValidator` / `ArrayValidator`; loader validation; any codegen consuming validator attrs (validator-derived CHECK constraints).

- [ ] **Step 1 — Fix `min`/`max` value-types to `int`.** `LengthValidator.java:44-49` + `NumericValidator.java:45-49` register `min`/`max` as `StringAttribute` — change to int to match the canonical. Confirm the loader + any CHECK-constraint codegen handle int.
- [ ] **Step 2 — Add `min`/`max` to `validator.base` + `validator.regex`.** The canonical declares `min`/`max` on every validator subtype (`MetaValidator.java:38` registers neither; `RegexValidator` lacks them). Register them.
- [ ] **Step 3 — Drop legacy extras.** Remove `mask` (`regex`), `minSize`/`maxSize` (`array`), and `msg` (all validators) — none have a canonical peer (analysis A-1 + B-3 decision: drop `msg`). Confirm no codegen/loader path depends on them; migrate if so.
- [ ] **Step 4 — Local un-skip → confirm validator rows match → re-skip. Review + simplify gate. Commit.** `feat(metadata): SP-G Phase2 Unit5 — validator int value-types + drop legacy mask/minSize/maxSize/msg (Java)`

### Unit 6: Required-ness + base-vs-leaf attr placement (A-3, C-4) + drop `defaultView` (C-3)

**Files:** `MetaIdentity` family, `Origin*` family, `Template*` family, `Source*`, `MetaField` (`defaultView`); loader validation.

- [ ] **Step 1 — Mark required attrs `required: true`.** `identity.*.fields`, `identity.reference.references`, `origin.aggregate` (`agg`/`of`/`via`), `origin.collection.via`, `origin.passthrough.from`, `template.*.payloadRef` (+ `toolName`). The manifest reads the declaration, so the registration must mark them required (Java enforces via separate constraints today — add the `required` flag to the attr declaration without removing the existing enforcement, or unify). Loader/conformance green.
- [ ] **Step 2 — Move base-declared attrs to concrete subtypes (C-4).** `source.base` → empty, rdb attrs on `source.rdb`; `template.base` → empty, attrs on `prompt`/`output`/`toolcall`; `origin.base` → empty, attrs on the concrete origins. Remove stray inherited attrs (`identity.secondary.generation`, etc.). This tightens Java's per-subtype inventory to match the canonical's per-subtype rows. Watch loader-validation ripple (attrs were validated at base level).
- [ ] **Step 3 — Drop `defaultView` in Java (C-3).** Confirm no backend codegen/runtime consumes `MetaField.defaultView` (the view investigation found no backend view consumers); remove the registration. If a consumer is found, escalate instead of removing.
- [ ] **Step 4 — Local un-skip → confirm these rows match → re-skip. Review + simplify gate. Commit.** `feat(metadata): SP-G Phase2 Unit6 — required-ness + base→leaf attr placement + drop defaultView (Java)`

### Unit 7: Physical `db*` vocabulary convergence (D-1) — largest blast radius

**Files:** `MetaField` + field subclasses (physical attr registration), `MetaObject` (`object.base` db attrs), `ChildRequirement` (add a physical/logical marker), the four emitters (filter physical-marked attrs), `omdb` (consumes `dbType`/`dbLength`/`dbNullable`/… for CRUD/codec), `codegen-spring` + `codegen-kotlin` (consume the `db*` set), DDL/auto-create paths if any remain.

- [ ] **Step 1 — Converge the logical-equivalent physical attrs onto cross-port names.** Map Java's `dbType`→`dbColumnType`, `dbIndex`→`db.indexed`, the physical column name→`column`, and the logical-but-db-prefixed `dbLength`/`dbPrecision`/`dbScale`/`dbUnique`/`dbNullable` onto the cross-port logical `maxLength`/`precision`/`scale`/`unique` (+ required-ness) — per `2026-05-23-persistence-attributes-cross-language-design.md`. Update `omdb` + both codegens to read the new names. Persistence + api-contract conformance green.
- [ ] **Step 2 — Add a physical/logical marker to `ChildRequirement` + filter physical attrs in the emitters.** The genuinely-physical Java extras with no cross-port logical peer (`dbSequenceName`/`dbIndexName`/`dbTablespace`/`previousName`/`dbType`-as-raw-sql-type) must be tagged physical so the manifest emitter (Java, and uniformly the others) filters them — matching the README EXCLUDED "physical bindings" rule. There is no such marker today; add it minimally. Document the marker + the exclusion in the README.
- [ ] **Step 3 — Local un-skip → confirm field/object physical rows match the canonical → re-skip. Review + simplify gate. Commit.** `feat(metadata): SP-G Phase2 Unit7 — converge physical db* vocab + physical-attr marker/filter (Java)`

---

## Phase 3 — Re-enable the gate + CI + docs

### Unit 8: Re-enable assertions, wire CI, finalize docs, merge

**Files:** `server/java/metadata/.../RegistryManifestConformanceTest.java`, `server/java/codegen-kotlin/.../RegistryManifestConformanceTest.kt` (drop `@Ignore`/`@Disabled`), `.github/workflows/conformance.yml`, `fixtures/registry-conformance/README.md`, `CLAUDE.md`.

- [ ] **Step 1 — Confirm all five ports byte-match.** Re-run all five registry-conformance emitters/tests against the final canonical — all green. If any port drifted during Phase 2's canonical regenerations, reconcile.
- [ ] **Step 2 — Re-enable the gated Java + Kotlin assertions.** Remove `@Ignore`/`@Disabled` from both `RegistryManifestConformanceTest`s; `mvn -pl metadata test` + the Kotlin module test green.
- [ ] **Step 3 — Wire CI.** Ensure all five registry-conformance runners execute in `conformance.yml` (TS/C#/Java/Python under the `conformance` matrix; Kotlin under `conformance-kotlin`). No Docker needed. Confirm picked up.
- [ ] **Step 4 — Docs.** README "Per-port status" → all five green; finalize the EXCLUDED list (arrays-as-`isArray`, structural keywords, `metadata.base`, generic `view.*`, physical `db*`). CLAUDE.md cross-language-porting section: point at the registry-conformance gate as the structural enforcer of "vocabularies identical across languages." Update the divergence-analysis doc status to "reconciled."
- [ ] **Step 5 — Final review + merge.** Simplifier + final reviewer over the whole reconciliation diff (focus: no physical/presentation facet leaked into the canonical; every Java registration change is matched by a green conformance corpus + updated consumers; the `{valueType, isArray}` + view-cut decisions are faithfully implemented). Merge forward (integrate-before-merge — main is active).

## Self-review notes
- **Phase 1 reverses two Unit-of-SP-G changes** (the Python `stringArray`→`stringarray` casing fix and the Python view-control additions). That is intended: SP-G landed the gate against the *then*-canonical; Phase 1 improves the canonical per the settled decisions. If SP-G has NOT yet merged, consider folding Phase 1 into the SP-G branch to avoid landing-then-rewriting the canonical.
- **The gate test is the spec.** Each Phase-2 unit's acceptance is "the targeted manifest rows now byte-match the canonical (local un-skip), conformance corpora stay green." Don't hand-edit the canonical to make Java pass — fix Java (the canonical is the settled TS/C#/Python contract, except where Phase 1 already changed it cross-port).
- **Blast-radius order matters.** Unit 7 (physical `db*`) is the largest and most likely to break `omdb`/codegen — do it last in Phase 2, after the cheaper vocabulary fixes have shrunk the diff.
- **`referencedBy` / `msg` / `defaultView` / legacy validator extras** are removals — always grep all JVM consumers (`omdb`, `codegen-spring`, `codegen-kotlin`) and migrate before deregistering; escalate if a real consumer exists rather than silently dropping behavior.
