# FR-024 Phase B — TS Metamodel Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement FR-024's metamodel core in the TypeScript reference port: `object.projection`, dotted `Entity.child` extends-resolution, identity pass-through, the `via` inference contract, value purity, and the hard-cutover loader rule — with the shared conformance corpus authored here as the cross-port contract.

**Architecture:** All loader-side: constants → registration (with a registry-manifest carve-out so the cross-port registry gate stays green until Phase E) → resolution (super-resolve) → validation passes (subtype rules, origin paths) → conformance fixtures (ledgered in Java/C#/Python until Phase E). DDL/codegen enforcement (assembly completeness) is deliberately Phase C, not here.

**Tech Stack:** TS (`server/typescript/packages/metadata`), Bun test, shared corpus `fixtures/conformance/`.

**Spec:** `docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md` + ADR-0028/0029/0030.

---

## Decisions this plan settles (spec §11 items assigned to Phase B)

**D1 — New error codes** (spec §11.1; added to `errors.ts` AND `fixtures/conformance/ERROR-CODES.json`, FR-014/FR-015 style — one code per assertable rule family):

| Code | Rule |
|---|---|
| `ERR_EXTENDS_TARGET_MISMATCH` | dotted `extends` resolved, but target's type/subtype ≠ referrer's (field.uuid extends a field.string, a field extends an identity, …) |
| `ERR_PROJECTION_IDENTITY_NOT_EXTENDED` | `identity.*` on an `object.projection` lacks `extends` |
| `ERR_IDENTITY_KEY_MISMATCH` | key correspondence broken: an extended-identity field has no local field extending it, or explicit `fields` disagrees with the computed set |
| `ERR_PROJECTION_SOURCE_WRITABLE` | a `source.*` on a projection has a writable `@kind` |
| `ERR_ENTITY_PRIMARY_SOURCE_READONLY` | **the hard cutover**: an entity's primary source has a read-only `@kind` |
| `ERR_AMBIGUOUS_PATH` | `via` omitted but >1 single-hop candidate relationship exists (error message names the candidates) |
| `ERR_ORIGIN_CARDINALITY` | passthrough via-path hops through a to-many / aggregate via-path has no to-many |
| `ERR_EXTENDS_ORIGIN_MISMATCH` | a field declares both `extends X` and an origin targeting Y, X ≠ Y (spec §11.3 settled: **error**, not warn — an incoherent declaration is never intended) |
| `ERR_IDENTITY_NAME_REQUIRED` | an `identity.*` node has no `name` (identities are now named, author-chosen — required so the dotted by-name extends form can address them) |

Value-purity violations (identity or source on a value) and the projection-extends-must-target-projection rule reuse the existing `ERR_SUBTYPE_RULE_VIOLATION` (shipped precedent: value-with-primary-identity already uses it).

**D2 — Identity names required (user ruling at plan review):** all `identity.*` nodes now REQUIRE a `name` (author-chosen: `id`, `key`, …; historically `identity.primary` was nameless — hard cutover, pre-GA, `ERR_IDENTITY_NAME_REQUIRED`). This makes the dotted by-name extends form **uniform across all node kinds** — no bare-ref special case: `identity.primary: { name: id, extends: Customer.id }` resolves Customer's *identity* named `id` (type-scoped — never the field of the same name). Consequence: every existing fixture/corpus/test input with a nameless `identity.primary` gains a name. Adding the name is **cross-port-safe** (all ports' serializers already handle named identities — secondaries are named today), so the name-sweep needs NO ledgering; only the new `error-identity-name-required` fixture is ledgered until Phase E (other ports don't enforce the requirement yet). Spec §5/§8 + ADR-0029 D4 amended at plan revision (done by controller).

**D3 — Enforcement-layer split:** Phase B enforces *reference resolution + structural rules* only. "Emitted assembly requires origins on non-base fields" is a **DDL-emit-time** rule (Phase C, migrate-ts) — load cannot know whether DDL will be emitted, and external-assembly sources legitimately have origin-less fields.

**D4 — Cross-port isolation until Phase E:**
- Registry: `object.projection` is registered in the TS registry but **excluded from the emitted manifest** via the classification mechanism in `registry-manifest.ts` (new `ExclusionReason`-style entry, e.g. `FR024_PENDING` — mirror how `TS_PILOT_VOCAB` worked before the `@responseRef` carve-out close). `expected-registry.json` is untouched; all five ports stay green. Phase E removes the exclusion atomically.
- Fixtures: every new fixture is added to the **expected-failures ledgers** of the non-TS ports (`server/java/metadata/conformance-expected-failures.json`, `server/python/tests/conformance/conformance-expected-failures.json`, the C# equivalent next to `MetaObjects.Conformance.Tests` — locate by `grep -rl expected-failures server/csharp/`), with a note naming FR-024 Phase E as the un-ledger point. **Legacy-fixture migrations (B4) change fixture inputs the other ports already pass — after migration those ports fail them, so the migrated names go into the same ledgers.**

**Expected.json workflow:** `expected.json`/`expected-effective.json` are **generated by the TS oracle** (load the fixture, run `canonicalSerialize`, write the bytes), then eyeballed for correctness — never hand-typed. Error fixtures' `expected-errors.json` ARE hand-written (they're the contract).

---

### Task B0: Spec/ADR amendment — identity names required ✅ DONE at plan revision

Spec §5/§8 examples now use `identity.primary: { name: id, extends: Customer.id }` and
state the name requirement; ADR-0029 Decision 4 amended to match. Done by the
controller when the user ruled on D2; no further action.

### Task B1: `object.projection` registration + manifest carve-out

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/object/object-constants.ts:13-21`
- Modify: `server/typescript/packages/metadata/src/core-types.ts:176-199`
- Modify: `server/typescript/packages/metadata/src/registry-manifest.ts` (classification)
- Test: `server/typescript/packages/metadata/test/registry-conformance.test.ts` (must stay green), new assertions in `server/typescript/packages/metadata/test/object-model-conformance.test.ts`
- Create fixture: `fixtures/conformance/projection-basic/`

- [ ] **Step 1: Write the failing tests** — in `object-model-conformance.test.ts` (or a new `projection-subtype.test.ts` beside it):

```ts
import { describe, expect, test } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { TYPE_OBJECT, TYPE_RELATIONSHIP, TYPE_FIELD, TYPE_IDENTITY, TYPE_SOURCE } from "../src/shared/base-types.js";
import { OBJECT_SUBTYPE_PROJECTION, OBJECT_SUBTYPES } from "../src/core/object/object-constants.js";
import { childRuleMatches } from "../src/registry.js";

describe("FR-024 object.projection registration", () => {
  const registry = composeRegistry(coreProviders);
  test("projection subtype is registered", () => {
    expect(OBJECT_SUBTYPES).toContain("projection");
    expect(registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_PROJECTION)).toBeDefined();
  });
  test("projection licenses field/identity/source children but NOT relationship/template", () => {
    const rules = registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_PROJECTION)!.childRules;
    const matches = (type: string) =>
      rules.some((r) => childRuleMatches(r, { type, subType: "x", name: "x" }));
    expect(matches(TYPE_FIELD)).toBe(true);
    expect(matches(TYPE_IDENTITY)).toBe(true);
    expect(matches(TYPE_SOURCE)).toBe(true);
    expect(matches(TYPE_RELATIONSHIP)).toBe(false);
    expect(matches("template")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd server/typescript && bun test packages/metadata/test/projection-subtype.test.ts` → FAIL (`OBJECT_SUBTYPE_PROJECTION` not exported).
- [ ] **Step 3: Implement constants** — `object-constants.ts`: add after line 14 `export const OBJECT_SUBTYPE_PROJECTION = "projection";` and extend the array + doc comment:

```ts
//   - projection : derived read-only representation of entities (FR-024, ADR-0028)
export const OBJECT_SUBTYPES = [
  SUBTYPE_BASE,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_PROJECTION,
] as const;
```

- [ ] **Step 4: Implement registration** — `core-types.ts` object loop (lines 176-199): projection gets its own rule list (no `TYPE_RELATIONSHIP`, no `TYPE_TEMPLATE`):

```ts
const projectionRules = [
  wildcard(TYPE_FIELD),
  wildcard(TYPE_IDENTITY),
  wildcard(TYPE_VALIDATOR),
  wildcard(TYPE_LAYOUT),
  wildcard(TYPE_SOURCE),
  wildcard(TYPE_ATTR),
];
// inside the loop:
const rules =
  subType === OBJECT_SUBTYPE_ENTITY ? [...objectRules, wildcard(TYPE_TEMPLATE)]
  : subType === OBJECT_SUBTYPE_PROJECTION ? projectionRules
  : objectRules;
```

(Import `OBJECT_SUBTYPE_PROJECTION` at line 66.)
- [ ] **Step 5: Manifest carve-out** — read `registry-manifest.ts` in full first. Add `object.projection` to the type-subtype exclusion classification with a documented reason (`FR024_PENDING — registered in TS only; atomic all-ports manifest flip in FR-024 Phase E`), mirroring the retired `TS_PILOT_VOCAB` pattern (see git history of the `@responseRef` carve-out, commit `574fd25d`, for the exact shape).
- [ ] **Step 6: Run the gates** — `bun test packages/metadata/test/projection-subtype.test.ts` → PASS; `bun test packages/metadata/test/registry-conformance.test.ts` → PASS (manifest byte-unchanged).
- [ ] **Step 7: Author `projection-basic` fixture** — `fixtures/conformance/projection-basic/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "demo",
    "children": [
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "Customer" } },
        { "field.uuid": { "name": "id" } },
        { "field.string": { "name": "name" } },
        { "field.string": { "name": "internalNotes" } },
        { "identity.primary": { "name": "id", "@fields": ["id"] } }
      ]}},
      { "object.projection": { "name": "CustomersV1", "children": [
        { "field.uuid": { "name": "customerId", "extends": "Customer.id", "@column": "customer_id" } },
        { "field.string": { "name": "name", "extends": "Customer.name" } },
        { "identity.primary": { "name": "id", "extends": "Customer.id" } }
      ]}}
    ]
  }
}
```

`providers.json`: `["metaobjects-core-types", "metaobjects-db"]`. Generate `expected.json` via the TS oracle once B2+B3 land (this fixture goes in NOW but its expected.json is written in B3's final step — until then keep the fixture dir out of git). Ledger `projection-basic` in the Java/Python/C# expected-failures files (D4).
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(metadata): register object.projection subtype + FR024_PENDING manifest carve-out (FR-024 B1)"`

### Task B2: Dotted `Entity.child` extends-resolution (fields)

**Files:**
- Modify: `server/typescript/packages/metadata/src/super-resolve.ts`
- Read first: `server/typescript/packages/metadata/src/shared/meta-data.ts` (`setSuperResolved`, ~line 380-490) and the parser's immediate-resolution call site (grep `resolveSuperRef(` in `src/`)
- Modify: `server/typescript/packages/metadata/src/errors.ts:19-88` (+`ERR_EXTENDS_TARGET_MISMATCH`)
- Test: `server/typescript/packages/metadata/test/super-resolve.test.ts`
- Create fixtures: `extends-entity-field-basic/`, `extends-entity-field-cross-package/`, `error-extends-entity-field-unresolved/`, `error-extends-entity-field-type-mismatch/`

- [ ] **Step 1: Write the failing unit tests** in `super-resolve.test.ts` (follow that file's existing tree-building helpers):

```ts
describe("FR-024 dotted Entity.child resolution", () => {
  test("Customer.id resolves to the field child of Customer", () => {
    // build tree: package acme; object.entity Customer with field.uuid id
    const target = resolveSuperRef("Customer.id", "acme", root);
    expect(target?.type).toBe("field");
    expect(target?.name).toBe("id");
  });
  test("cross-package acme::sales::Customer.id resolves", () => {
    const target = resolveSuperRef("acme::sales::Customer.id", "other", root2);
    expect(target?.name).toBe("id");
  });
  test("dot binds to the LAST segment only — package separators still ::", () => {
    expect(resolveSuperRef("Customer.nosuch", "acme", root)).toBeUndefined();
  });
  test("plain refs without dots are unaffected (regression)", () => {
    expect(resolveSuperRef("Customer", "acme", root)?.type).toBe("object");
  });
});
```

- [ ] **Step 2: Run to verify failure** — dotted tests FAIL (today the `.` is treated as part of the name and nothing matches).
- [ ] **Step 3: Implement in `super-resolve.ts`** — add a dotted-ref branch to `resolveSuperRef` (after the absolute/relative handling, BEFORE the bare-name fallback; a ref "contains a dotted child segment" iff the substring after the last `::` contains `.`):

```ts
// FR-024 (ADR-0029): dotted ref "<objectRef>.<childName>" — resolve the object
// part with the existing strategies, then select the named child (effective
// children: inherited fields are addressable too).
const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
const tail = ref.slice(lastSep + (lastSep === -1 ? 0 : PACKAGE_SEPARATOR.length));
const dot = tail.indexOf(".");
if (dot !== -1) {
  const objectRef = ref.slice(0, ref.length - (tail.length - dot));
  const childName = tail.slice(dot + 1);
  if (childName.length > 0 && !childName.includes(".")) {
    const owner = resolveSuperRef(objectRef, contextPackage, root);
    if (owner !== undefined) {
      return owner.children().find((c) => c.name === childName);
    }
  }
  return undefined; // dotted form that didn't resolve — never fall through to bare lookup
}
```

Multi-dot (`X.y.z`) is intentionally unresolvable (reserved). NOTE: returning the child means `setSuperResolved` receives a non-top-level node — read `setSuperResolved` and confirm no top-level assumption; if it validates type equality already, reuse; if not, add the **type/subtype scope check at both call sites** (parser-immediate and `resolveDeferredSupers`): referrer.type must equal target.type AND referrer.subType must equal target.subType, else emit `ERR_EXTENDS_TARGET_MISMATCH` (new code; ParseError with FR5d `resolvedSource(base, referrerFqn, ref)`).
- [ ] **Step 4: Add the error code** — `errors.ts` ERROR_CODES array + `fixtures/conformance/ERROR-CODES.json`: `"ERR_EXTENDS_TARGET_MISMATCH": "FR-024: a dotted extends ref resolved to a node whose type or subtype does not match the extending node (a field may only extend a field of the same subtype; an identity only an identity)."`
- [ ] **Step 5: Run unit tests** → PASS. Run the FULL metadata suite (`bun test packages/metadata`) → PASS (no regression in existing extends behavior).
- [ ] **Step 6: Author the four fixtures.** `extends-entity-field-basic` (entity + value whose field extends the entity field — proves inheritance: the value field's effective validators/docs include the entity field's; include a `validator.required` on the entity field and assert via `expected-effective.json`); `extends-entity-field-cross-package` (two packages, FQN dotted ref); `error-extends-entity-field-unresolved`:

```json
{ "errors": [ { "code": "ERR_UNRESOLVED_SUPER",
    "source": { "format": "resolved", "files": ["meta.demo.json"],
                "referrer": "demo::Args::customerId", "target": "Customer.nosuch" } } ],
  "warnings": [] }
```

(match the exact envelope shape the loader emits — generate once, verify by hand, commit); `error-extends-entity-field-type-mismatch` (field.uuid extends Customer.name where name is field.string → `ERR_EXTENDS_TARGET_MISMATCH`). Ledger all four in the three non-TS ports.
- [ ] **Step 7: Commit** — `git commit -m "feat(metadata): dotted Entity.field extends-resolution + ERR_EXTENDS_TARGET_MISMATCH (FR-024 B2, ADR-0029)"`

### Task B3: Identity names required + identity pass-through + key correspondence

**Files:**
- Modify: `server/typescript/packages/metadata/src/subtype-rules.ts` OR a parse-level check (investigate where nameless nodes surface) — the name requirement
- Create: `server/typescript/packages/metadata/src/core/identity/validate-identity-passthrough.ts`
- Modify: loader pipeline (`src/loader/meta-data-loader.ts`, after subtype rules ~line 432) to call the new pass
- Modify: `errors.ts` + `ERROR-CODES.json` (+`ERR_IDENTITY_NAME_REQUIRED`, +`ERR_PROJECTION_IDENTITY_NOT_EXTENDED`, +`ERR_IDENTITY_KEY_MISMATCH`)
- Sweep: every input under `fixtures/conformance/`, `fixtures/persistence-conformance/`, `fixtures/render-conformance/`, `fixtures/api-contract-conformance/`, `library/`, TS unit-test inline metadata, and `meta init` scaffold templates with a nameless `identity.*` gains a name (convention: primary → `"id"` unless context suggests better; keep secondary names as-is)
- Test: new `test/identity-passthrough.test.ts`
- Fixtures: finish `projection-basic` (expected.json via oracle), `projection-identity-fields-explicit/`, `error-identity-name-required/`, `error-projection-identity-not-extended/`, `error-identity-key-mismatch/`

- [ ] **Step 1: Failing tests** — `identity-passthrough.test.ts`: (a) an `identity.*` node without a name → `ERR_IDENTITY_NAME_REQUIRED`; (b) `identity.primary { name: "id", extends: "Customer.id" }` on a projection resolves to Customer's IDENTITY named `id` (assert `superResolved.type === TYPE_IDENTITY`), never the field `id` (type-scoped, falls out of B2's dotted branch + scope check — this test pins it); (c) its effective `fields` is computed as `["customerId"]` from the local field extending `Customer.id`; (d) explicit `@fields: ["customerId"]` that agrees → ok; disagrees → `ERR_IDENTITY_KEY_MISMATCH`; (e) entity-identity field `id` with NO local field extending it → `ERR_IDENTITY_KEY_MISMATCH`; (f) identity on projection without extends → `ERR_PROJECTION_IDENTITY_NOT_EXTENDED`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the name requirement** — emit `ERR_IDENTITY_NAME_REQUIRED` for any `TYPE_IDENTITY` node with empty/absent name (place it where it fires once per node: the subtype-rules walk is the natural host). Confirm B2's type-scope check makes the dotted identity resolution work with NO new resolution code (a `Customer.id` ref from an identity referrer must select among Customer's children of the REFERRER's type — if B2 implemented child-selection as name-only `children().find(name)`, tighten it to `find(c => c.name === childName && c.type === referrer.type)`; thread the referrer type into the dotted branch).
- [ ] **Step 4: Implement the validation pass** — `validate-identity-passthrough.ts`, walk objects of subtype projection: every identity child must have `superResolved` (else `ERR_PROJECTION_IDENTITY_NOT_EXTENDED`); for each field name F in the extended identity's `@fields`, find the local field whose `superResolved` is the entity's field F (else `ERR_IDENTITY_KEY_MISMATCH`); computed local `fields` = those local field names in the extended identity's order; explicit `@fields` must equal the computed list (else `ERR_IDENTITY_KEY_MISMATCH`). Export a function returning `ParseError[]`; wire into the loader pipeline after `validateSubtypeRules`.
- [ ] **Step 5: The name sweep** — run the full TS suite; every failure from the new requirement IS the sweep list. Add names to all nameless identities in the corpora/library/tests/scaffold; regenerate affected `expected.json` files via the oracle (the serializer now emits the names). Cross-port-safe per D2 — do NOT ledger the swept fixtures; spot-check by running one other port's conformance suite if available locally (optional; CI is the backstop).
- [ ] **Step 6: Run all tests** → PASS. Generate `projection-basic/expected.json`; author `projection-identity-fields-explicit` + the three error fixtures (hand-write envelopes). Ledger the four NEW fixtures (not the swept ones) in 3 ports.
- [ ] **Step 7: Commit** — `git commit -m "feat(metadata): identity names required + identity pass-through, key correspondence, computed fields (FR-024 B3)"`

### Task B4: Subtype rules — projection licensing, value purity, the hard cutover

**Files:**
- Modify: `server/typescript/packages/metadata/src/subtype-rules.ts`
- Modify: `server/typescript/packages/metadata/src/persistence/source/validate-source-roles.ts` (writable-primary rule lives beside the one-primary rule)
- Modify: `errors.ts` + `ERROR-CODES.json` (+`ERR_PROJECTION_SOURCE_WRITABLE`, +`ERR_ENTITY_PRIMARY_SOURCE_READONLY`)
- Test: extend `test/` beside existing subtype-rule tests
- Fixtures: new error fixtures + **legacy migrations**

- [ ] **Step 1: Failing tests** for each rule:
  - value + ANY identity subtype → `ERR_SUBTYPE_RULE_VIOLATION` (extend the existing primary-only rule: spec says values have NO identity, ever)
  - value + any `source.*` child → `ERR_SUBTYPE_RULE_VIOLATION`
  - projection + object-level `extends` whose target is NOT `object.projection` → `ERR_SUBTYPE_RULE_VIOLATION` (kills the firehose; projection-extends-projection allowed)
  - projection + source with writable `@kind` (table) → `ERR_PROJECTION_SOURCE_WRITABLE` (use `SOURCE_READ_ONLY_KINDS` from `source-constants.ts:98-103`)
  - entity whose PRIMARY source has read-only `@kind` → `ERR_ENTITY_PRIMARY_SOURCE_READONLY` (in `validate-source-roles.ts`, where the primary is already identified; read-only kinds legal in non-primary roles)
  - projection without identity → NO error (identity optional); entity-no-identity warning unchanged
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `subtype-rules.ts` (value/projection rules — note `model.superResolved` for the extends-target rule) and `validate-source-roles.ts` (writable-primary; import `SOURCE_READ_ONLY_KINDS` + `SOURCE_ATTR_KIND`). **Step 4: Run** → PASS.
- [ ] **Step 5: Migrate the legacy fixtures the cutover breaks.** Run the full conformance suite (`bun test packages/metadata`) — every fixture that now fails IS the migration list; expect at least: `source-db-view-projection`, `field-readonly-on-view-projection` (entity+view-primary), `parameter-ref-on-stored-proc`, `parameter-ref-no-args`, `parameter-ref-optional-parameter`, `parameter-ref-shared-across-procs`, `parameter-ref-with-origin-passthrough`, `source-rdb-kind-proc-with-proc-attr`, `source-rdb-kind-view-with-view-attr`, `source-rdb-kind-function-with-function-attr`, possibly `flattened-kitchen-sink` + `origin-*` + `error-parameter-ref-*` + `error-source-rdb-physical-name-*` inputs (view/proc-sourced entities embedded in error fixtures must be migrated WITHOUT changing what the fixture tests). For each: rewrite the view/proc-sourced `object.entity` as `object.projection` (drop now-redundant `@readOnly` flags in `field-readonly-on-view-projection` — rename it `projection-fields-readonly` if its purpose is now covered elsewhere, else delete it and note why in the commit), regenerate `expected.json` via the oracle, hand-update error envelopes' jsonPaths. **Add every migrated fixture name to the three non-TS ledgers** (they pass the OLD inputs; they can't load `object.projection` until Phase E).
- [ ] **Step 6: New error fixtures** — `error-entity-primary-source-readonly/` (the cutover: old-style ProgramSummary entity+view → expect `ERR_ENTITY_PRIMARY_SOURCE_READONLY`; THIS is the fixture that proves the firehose spelling is dead), `error-value-with-source/`, `error-projection-source-writable/`, `error-projection-extends-entity/`. Ledger ×3.
- [ ] **Step 7: Full suite green; commit** — `git commit -m "feat(metadata): projection/value subtype rules + entity writable-primary-source hard cutover; legacy fixture migration (FR-024 B4, ADR-0028)"`

### Task B5: `via` inference + cardinality checks

**Files:**
- Read first: `server/typescript/packages/metadata/src/loader/validation-passes.ts:336-542` in full (`_validateFromPath`, `_validateViaPath`, `validateOriginPaths`)
- Modify: `validation-passes.ts`; `errors.ts` + `ERROR-CODES.json` (+`ERR_AMBIGUOUS_PATH`, +`ERR_ORIGIN_CARDINALITY`)
- Test: extend the origin-path tests (find them: `grep -rl validateOriginPaths packages/metadata/test/`)
- Fixtures: `origin-via-inferred-single-hop/`, `error-origin-via-ambiguous/`, `error-origin-passthrough-to-many/`, `error-origin-aggregate-no-to-many/`

- [ ] **Step 1: Failing tests:**
  - **Base-entity derivation:** for a projection, base = the extended identity's owner entity (B3); fallback when no identity: the single entity targeted by plain field-extends (>1 distinct → require identity, error `ERR_AMBIGUOUS_PATH` with message saying "declare an extended identity"). For an entity (derived fields on entities), base = the entity itself.
  - `origin.passthrough { from: "Country.name" }` with NO `via`, base entity has exactly ONE relationship whose `@objectRef` is Country → resolves (inferred single hop).
  - Two relationships to Country → `ERR_AMBIGUOUS_PATH` naming both.
  - `from` entity not reachable in one hop and no `via` → existing `ERR_INVALID_ORIGIN` (cannot infer multi-hop).
  - passthrough `via` path with any hop of `@cardinality: many` → `ERR_ORIGIN_CARDINALITY`.
  - aggregate `via` path with NO `many` hop → `ERR_ORIGIN_CARDINALITY`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** inside `validateOriginPaths` and `_validateViaPath`: thread the derived base entity; when `via` absent and the `from`/`of` owner ≠ base, scan base's relationship children (effective, `children()`) for `@objectRef === fromEntity` — exactly one → treat as the inferred path; record cardinality per hop from `@cardinality` (constant in `relationship-constants.ts`). Inference must be observable: the resolved path participates in the same downstream validation as an explicit via.
- [ ] **Step 4: Run** → PASS, full suite green. **Step 5: Author the four fixtures** (+ ledger ×3). Note `origin-via-inferred-single-hop` exercises projection-hosted origins; add a variant block in the same fixture for an entity-hosted derived field (multi-source) to lock the both-hosts contract.
- [ ] **Step 6: Commit** — `git commit -m "feat(metadata): via single-hop-unique inference + origin cardinality checks (FR-024 B5, ADR-0029)"`

### Task B6: extends/origin agreement + derived-field providability

**Files:**
- Modify: `validation-passes.ts` (agreement inside `validateOriginPaths`; providability as a small new pass or in `validate-source-roles.ts`)
- Modify: `errors.ts` + `ERROR-CODES.json` (+`ERR_EXTENDS_ORIGIN_MISMATCH`, +`ERR_DERIVED_FIELD_NO_READ_SOURCE`)
- Fixtures: `error-extends-origin-mismatch/`, `error-derived-field-no-read-source/`, `entity-derived-fields-multi-source/` (happy: the §7 worked example — Customer + table-primary + view-read + countryName w/ extends+origin)

- [ ] **Step 1: Failing tests:** (a) field with `extends: "Country.name"` + `origin.passthrough { from: "Region.name" }` → `ERR_EXTENDS_ORIGIN_MISMATCH`; agreeing targets → no error; (b) `object.entity` with ONLY a table source + a field carrying `origin.*` → `ERR_DERIVED_FIELD_NO_READ_SOURCE`; same entity + a read-role view source → ok; projection-hosted derived fields exempt (the projection's source/wire IS the provider).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (agreement: compare the field's `superResolved` node against the origin's resolved `from` target — same node identity). **Step 4: PASS + full suite.** **Step 5: fixtures** (oracle-generate the happy one; hand-write the two error envelopes; ledger ×3).
- [ ] **Step 6: Commit** — `git commit -m "feat(metadata): extends/origin agreement + derived-field providability checks (FR-024 B6)"`

### Task B7: Phase-B close-out

**Files:**
- Verify: `fixtures/conformance/ERROR-CODES.json` (all 8 new codes present with FR-024 descriptions)
- Run: fixture-lint, full TS suite, registry-conformance
- Modify: ledgers (final reconciliation), memory of migrated-fixture list for Phase E

- [ ] **Step 1:** `cd server/typescript && bun test` → entire server suite green.
- [ ] **Step 2:** Run the conformance fixture lint (`bun run conformance lint fixtures/conformance` or the in-repo equivalent — see `packages/conformance/bin/conformance.ts`) → clean; every new error fixture's code exists in ERROR-CODES.json.
- [ ] **Step 3:** `bun test packages/metadata/test/registry-conformance.test.ts` → green (manifest still byte-identical to `expected-registry.json` — carve-out holding).
- [ ] **Step 4:** `bun run --filter '*' typecheck` from repo root → green (the pre-push gate).
- [ ] **Step 5:** Write the Phase-E handoff list into the plan dir: `docs/superpowers/plans/2026-06-12-fr-024-phase-e-handoff.md` — the exact ledgered fixture names per port + the `FR024_PENDING` manifest exclusion to remove + the migrated-fixture diffs the other ports must absorb. Commit.
- [ ] **Step 6:** Final commit + report: `git commit -m "chore(fr-024): phase B close-out — lint, gates, phase-E handoff ledger"`

---

## Plan self-review (done at authoring)

1. **Spec coverage:** §3 taxonomy → B1/B4; §4 extends → B2; §5 identity → B3 (+B0 grammar amendment); §6 via → B5; §7 doctrine/assembly-modes → B4 (sources) + B6 (providability) + D3 (emitted-assembly deferred to C); §10 removals → B4; §11.1/11.3 → D1. Registry isolation → D4/B1; fixture isolation → ledgers in every fixture step.
2. **Placeholder scan:** investigation-first steps ("read X in full") are explicit where the file wasn't read at planning (validation-passes internals, registry-manifest classification, setSuperResolved) — each paired with a complete behavioral contract + test code, which is the binding spec. No TBDs.
3. **Type consistency:** `OBJECT_SUBTYPE_PROJECTION`, error-code names, and fixture names are spelled identically across tasks; B3 depends on B2's resolution branch; B5 depends on B3's base-entity derivation — order is the task order.
