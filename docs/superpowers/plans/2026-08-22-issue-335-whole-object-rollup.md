# Whole-Object Rollup (#335) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@of` optional on `origin.aggregate @agg: collect`, so a projection can roll up related rows as a JSON array of a declared value-object — and close the two holes in the queryable-projection contract that such a column would otherwise land in.

**Architecture:** Two halves. **Half B first** (two loader rules making the filter/sort contract honest about array columns) so Half A lands into a correct tier. **Half A** then splits `collect` out of the `@of`-required gate in all four loaders, adds a value-object member→column resolution rule, and emits a new `collectObjectAgg` view column lowered to `jsonb_agg(jsonb_build_object(…))` on Postgres and `json_group_array(json_object(…))` on SQLite. Codegen is TypeScript-only (ADR-0015); the loader rules are cross-port.

**Tech Stack:** TypeScript (Bun), C#, Java, Python. Shared JSON conformance corpus. Postgres + SQLite via Testcontainers.

**Spec:** [`docs/superpowers/specs/2026-08-22-issue-335-whole-object-rollup-design.md`](../specs/2026-08-22-issue-335-whole-object-rollup-design.md)

## Global Constraints

- **`metamodelVersion` is NOT edited by this work.** It is already `0.11` (moved by #342) and that bump is unreleased. **Re-check before merging:** if `0.24.1` has shipped by then, `0.11` is released and this needs `node scripts/check-metamodel-version.mjs --set 0.12`.
- **ADR-0039 — never use own-only accessors.** Read `isArray` as `field.resolvedIsArray()`, attrs as `field.attr(...)`, children as `.children()`. `field.isArray` and `ownAttr`/`ownChildren` silently drop everything inherited via `extends`. The one exception in this plan is reading an `origin.*` node's own attrs (`origin.ownAttr(...)`), because `origin.*` never inherits (ADR-0029) — the existing code does this and carries that comment.
- **ADR-0023 — never invent an attribute.** This work adds **no** new registered attribute. `@of` is already `"required": false` structurally.
- **Named constants only.** Never inline `"collect"`, `"field"`, `"object"` etc. Import from `packages/metadata/src/constants.ts` (TS) and each port's equivalent.
- **Public repository.** No private/other-project names, no absolute home paths, in code, docs, fixtures **or commit messages**.
- **Every new load error needs a shared corpus fixture that triggers it.** A port-local unit test does not substitute — it proves one port enforces the rule, which is the true-but-insufficient assertion behind three separate #342 findings.
- **Scalar-arm output must stay byte-identical.** A `collect` **with** `@of` emits exactly the SQL it emits today. This is pinned by an explicit no-churn test, not assumed.
- **Test scoping.** Never run a bare `bun test` at the repo root. Scope to the package.

## File Structure

**Half B — loader only (4 ports):**
- `server/typescript/packages/metadata/src/loader/validation-passes.ts` — extend `validateFilterableHasSupportedOps`
- `server/csharp/MetaObjects/Loader/ValidationPasses.cs` — same rule
- `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java` — same rule
- `server/python/src/metaobjects/loader/validation_passes.py` — same rule
- `fixtures/conformance/error-filterable-array-field/` — new negative fixture
- `fixtures/conformance/error-sortable-array-field/` — new negative fixture

**Half A — loader (4 ports):** same four files, the `origin.aggregate` block.

**Half A — registry prose (7 byte-gated files):**
- `spec/metamodel/origin.json`
- `fixtures/registry-conformance/expected-registry.json`
- `fixtures/metamodel-docs/expected/types/origin.md`
- `server/csharp/MetaObjects/Persistence/Origin/OriginSchema.cs`
- `server/csharp/MetaObjects/SpecMetamodel/origin.json`
- `server/python/src/metaobjects/spec_metamodel/origin.json`
- `server/typescript/packages/metadata/src/persistence/origin/origin-definition.embedded.ts`

**Half A — codegen (TypeScript only):**
- `server/typescript/packages/codegen-ts/src/projection/view-spec.ts` — new `collectObjectAgg` kind
- `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts` — object arm
- `server/typescript/packages/codegen-ts/src/projection/view-ddl-emit.ts` — both dialects

**Half A — gates:**
- `fixtures/conformance/collect-whole-object/` + 6 negative fixtures
- `fixtures/conformance/flattened-kitchen-sink/` — restore `supplierBriefs`
- `server/typescript/packages/integration-tests/test/view-lifecycle-{pg,sqlite}.test.ts` — round-trip

---

## Task 1: Half B — array fields cannot be `@filterable` (TypeScript)

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts` (function `validateFilterableHasSupportedOps`, currently at ~`:436-456`)
- Test: `server/typescript/packages/metadata/test/validation-filterable-array.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the extended `validateFilterableHasSupportedOps(root: MetaData): ParseError[]`, emitting `ERR_FILTERABLE_UNSUPPORTED_SUBTYPE` for array fields. Task 2 ports this rule; Task 3 gates it cross-port.

**Why:** `filterSubTypeFor` in `codegen-ts/src/templates/filter-allowlist.ts` falls through to `"string"` for anything unrecognised and **nothing in that file consults `isArray`**, so `field.string isArray: true @filterable: true` emits a `like`/`eq` rule against a `text[]` column — SQL that cannot execute. No operator in the FR-009 band applies to an array, which is the same reason `field.object` is already rejected, so it reuses the same error code and the same door.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/validation-filterable-array.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

const model = (fieldJson: string) => `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": {
          "name": "Product",
          "children": [
            { "source.rdb": { "@kind": "table", "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": ["id"] } },
            ${fieldJson}
          ]
      }}
    ]
  }
}`;

describe("@filterable on an array field", () => {
  test("an array field marked @filterable fails to load", () => {
    const src = model(
      `{ "field.string": { "name": "tags", "isArray": true, "@filterable": true } }`,
    );
    const loader = new MetaDataLoader();
    expect(() => loader.loadFromString(src, "meta.demo.json")).toThrow(
      /ERR_FILTERABLE_UNSUPPORTED_SUBTYPE/,
    );
  });

  test("the same field WITHOUT isArray still loads", () => {
    const src = model(
      `{ "field.string": { "name": "tags", "@filterable": true } }`,
    );
    const loader = new MetaDataLoader();
    expect(() => loader.loadFromString(src, "meta.demo.json")).not.toThrow();
  });

  test("an array field NOT marked @filterable still loads", () => {
    const src = model(
      `{ "field.string": { "name": "tags", "isArray": true } }`,
    );
    const loader = new MetaDataLoader();
    expect(() => loader.loadFromString(src, "meta.demo.json")).not.toThrow();
  });
});
```

> If `loadFromString` is not the loader's string entry point in this codebase, find the one the neighbouring tests in `server/typescript/packages/metadata/test/` use and match it exactly — do not invent an API.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server/typescript/packages/metadata && bun test test/validation-filterable-array.test.ts
```

Expected: the first test FAILS (no error is thrown); the other two PASS.

- [ ] **Step 3: Extend the validation pass**

In `validation-passes.ts`, inside `validateFilterableHasSupportedOps`, replace the single-condition body of the field loop with an array check ahead of the subtype check:

```ts
      // ADR-0039: resolving — a concrete field may inherit @filterable via extends.
      if (field.attr(FIELD_ATTR_FILTERABLE) !== true) continue;

      // #335 Half B — an ARRAY field has no operator band either. Every FR-009
      // operator (eq/ne/gt/gte/lt/lte/in/like/isNull) is a scalar comparison;
      // none applies to a collection column. The allowlist template does not
      // consult isArray and falls through to the "string" band, so this
      // previously emitted a `like` rule against a text[] column — SQL that
      // cannot execute. Same reason as the subtype check below, so same code.
      // ADR-0039: resolvedIsArray(), never the own `isArray` flag.
      if (field.resolvedIsArray()) {
        errors.push(
          new ParseError(
            `Field "${obj.name}.${field.name}" has @filterable: true but is an array ` +
              `(isArray: true). No filter operator applies to a collection column. ` +
              `Remove @filterable from this field.`,
            { code: "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE", source: field.source },
          ),
        );
        continue;
      }

      if (opsForSubType(field.subType).length > 0) continue;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server/typescript/packages/metadata && bun test test/validation-filterable-array.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Run the full metadata suite for regressions**

```bash
cd server/typescript/packages/metadata && bun test
```

Expected: 0 fail. If an existing fixture breaks, it is declaring `@filterable` on an array field — read it before changing it; that fixture is pinning the defect.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts \
        server/typescript/packages/metadata/test/validation-filterable-array.test.ts
git commit -m "fix(metamodel): an array field has no filter-operator band either (#335)"
```

---

## Task 2: Half B — `@sortable` gets the same subtype/array validation (TypeScript)

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts`
- Test: `server/typescript/packages/metadata/test/validation-sortable-array.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's extended `validateFilterableHasSupportedOps`.
- Produces: `validateSortableHasSupportedSubtype(root: MetaData): ParseError[]`, exported alongside it and registered in the same pass list. Task 3 gates it.

**Why:** `@sortable` defaults from `@filterable`, so it is only independently set when explicit — and **nothing validates it at all**, versus a hard error for `@filterable`. `@sortable: true` on a JSON or array column currently passes the loader and emits a sort entry over a column that cannot be ordered.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/validation-sortable-array.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

const model = (fieldJson: string) => `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": {
          "name": "Product",
          "children": [
            { "source.rdb": { "@kind": "table", "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": ["id"] } },
            ${fieldJson}
          ]
      }}
    ]
  }
}`;

describe("@sortable subtype validation", () => {
  test("an array field marked @sortable fails to load", () => {
    const src = model(
      `{ "field.string": { "name": "tags", "isArray": true, "@sortable": true } }`,
    );
    const loader = new MetaDataLoader();
    expect(() => loader.loadFromString(src, "meta.demo.json")).toThrow(
      /ERR_SORTABLE_UNSUPPORTED_SUBTYPE/,
    );
  });

  test("a field.object marked @sortable fails to load", () => {
    const src = model(
      `{ "field.object": { "name": "spec", "@objectRef": "acme::shop::Spec", "@sortable": true } }`,
    );
    const loader = new MetaDataLoader();
    expect(() => loader.loadFromString(src, "meta.demo.json")).toThrow(
      /ERR_SORTABLE_UNSUPPORTED_SUBTYPE/,
    );
  });

  test("a plain scalar marked @sortable still loads", () => {
    const src = model(
      `{ "field.string": { "name": "sku", "@sortable": true } }`,
    );
    const loader = new MetaDataLoader();
    expect(() => loader.loadFromString(src, "meta.demo.json")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server/typescript/packages/metadata && bun test test/validation-sortable-array.test.ts
```

Expected: the first two FAIL (nothing thrown); the third PASSES.

- [ ] **Step 3: Add the error code to the ledger**

`ERR_SORTABLE_UNSUPPORTED_SUBTYPE` is new. Add it to **all** of:
- `fixtures/conformance/ERROR-CODES.json`
- `server/typescript/packages/metadata/src/errors.ts` (exact-bidirectional — the TS ledger test fails if the sets differ)
- `server/python/src/metaobjects/errors.py` (superset)
- `server/java/metadata/src/main/java/com/metaobjects/ErrorCode.java`
- `server/csharp/MetaObjects/Errors.cs`

Copy the description style of the neighbouring `ERR_FILTERABLE_UNSUPPORTED_SUBTYPE` entry. Do not paraphrase the rule differently in different ports — the strings are compared.

- [ ] **Step 4: Write the validation pass**

In `validation-passes.ts`, directly below `validateFilterableHasSupportedOps`:

```ts
// @sortable on a subtype or shape that cannot be ordered (#335 Half B)
// ---------------------------------------------------------------------------
// @sortable defaults FROM @filterable, so it is independently set only when
// explicit — and nothing validated it, while @filterable has had a hard error
// since SP-H Unit9. A @sortable JSON or array column emits a sort entry over a
// column no dialect can ORDER BY meaningfully. → ERR_SORTABLE_UNSUPPORTED_SUBTYPE.

export function validateSortableHasSupportedSubtype(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // children() — inherited @sortable fields (via extends:/super:) are visible.
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: resolving — a concrete field may inherit @sortable via extends.
      if (field.attr(FIELD_ATTR_SORTABLE) !== true) continue;
      // ADR-0039: resolvedIsArray(), never the own `isArray` flag.
      const isArray = field.resolvedIsArray();
      if (!isArray && opsForSubType(field.subType).length > 0) continue;
      errors.push(
        new ParseError(
          `Field "${obj.name}.${field.name}" has @sortable: true but ` +
            (isArray
              ? `is an array (isArray: true) — a collection column has no ordering.`
              : `its subtype "${field.subType}" cannot be ordered.`) +
            ` Remove @sortable from this field.`,
          { code: "ERR_SORTABLE_UNSUPPORTED_SUBTYPE", source: field.source },
        ),
      );
    }
  }
  return errors;
}
```

Register it in the same list that calls `validateFilterableHasSupportedOps` — grep for that name to find the pass registry and add the new function immediately after it.

If `FIELD_ATTR_SORTABLE` does not exist in `constants.ts`, add it there beside `FIELD_ATTR_FILTERABLE`; do not inline `"sortable"`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server/typescript/packages/metadata && bun test test/validation-sortable-array.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 6: Run the full metadata suite**

```bash
cd server/typescript/packages/metadata && bun test
```

Expected: 0 fail.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts \
        server/typescript/packages/metadata/src/errors.ts \
        server/typescript/packages/metadata/test/validation-sortable-array.test.ts \
        fixtures/conformance/ERROR-CODES.json \
        server/python/src/metaobjects/errors.py \
        server/java/metadata/src/main/java/com/metaobjects/ErrorCode.java \
        server/csharp/MetaObjects/Errors.cs
git commit -m "fix(metamodel): @sortable gets the subtype validation @filterable already had (#335)"
```

---

## Task 3: Half B — shared conformance fixtures

**Files:**
- Create: `fixtures/conformance/error-filterable-array-field/input/meta.demo.json`
- Create: `fixtures/conformance/error-filterable-array-field/expected-errors.json`
- Create: `fixtures/conformance/error-sortable-array-field/input/meta.demo.json`
- Create: `fixtures/conformance/error-sortable-array-field/expected-errors.json`
- Modify: `fixtures/conformance/README.md`

**Interfaces:**
- Consumes: the two rules from Tasks 1–2.
- Produces: the cross-port gate. Task 4's port work is verified against these.

**Why:** This is the point of Half B. A load error with no fixture that triggers it is the same blind spot one layer up — "no fixture covers it" and "every port enforces it" are indistinguishable on a green suite. A structural scan of 1321 JSON and 124 YAML files found **zero** fields carrying both `isArray: true` and `@filterable`/`@sortable: true`, so nothing in the corpus exercises an array field through the filter tier at all.

- [ ] **Step 1: Create the filterable fixture input**

`fixtures/conformance/error-filterable-array-field/input/meta.demo.json`:

```json
{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      {
        "object.entity": {
          "name": "Product",
          "children": [
            { "source.rdb": { "@kind": "table", "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": ["id"] } },
            { "field.string": { "name": "tags", "isArray": true, "@filterable": true } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Create the filterable expected-errors**

`fixtures/conformance/error-filterable-array-field/expected-errors.json`:

```json
{
  "errors": [
    {
      "code": "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE",
      "source": {
        "format": "json",
        "files": ["meta.demo.json"],
        "jsonPath": "$['metadata.root'].children[0]['object.entity'].children[3]['field.string']"
      }
    }
  ],
  "warnings": []
}
```

- [ ] **Step 3: Create the sortable fixture**

Same two files under `fixtures/conformance/error-sortable-array-field/`, with the field changed to `"@sortable": true` and the code to `ERR_SORTABLE_UNSUPPORTED_SUBTYPE`.

- [ ] **Step 4: Run the TS conformance corpus**

```bash
cd server/typescript/packages/metadata && bun test test/conformance.test.ts
```

Expected: PASS, count increased by 2. If the `jsonPath` in `expected-errors.json` does not match, the failure message prints the actual path — copy it verbatim rather than guessing.

- [ ] **Step 5: Document the fixtures in the corpus README**

In `fixtures/conformance/README.md`, add both fixtures to the case list, each with one line saying which rule it covers. State that they are the **only** cases exercising an array field through the filter/sort tier.

- [ ] **Step 6: Commit**

```bash
git add fixtures/conformance/error-filterable-array-field \
        fixtures/conformance/error-sortable-array-field \
        fixtures/conformance/README.md
git commit -m "test(conformance): gate the array filter/sort rules cross-port (#335)"
```

---

## Task 4: Half B — port the two rules to C#, Java, Python

**Files:**
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java`
- Modify: `server/python/src/metaobjects/loader/validation_passes.py`

**Interfaces:**
- Consumes: Tasks 1–3. The TypeScript implementation is the reference; the fixtures are the contract.
- Produces: all four ports green on the two fixtures from Task 3.

**Why:** The loader contract is cross-port. Four ports hand-rolling the same read is what produced the `@fields` divergence in #342 — so implement each against the fixture, not against a reading of the TS source.

- [ ] **Step 1: Find each port's filterable pass**

```bash
grep -rn "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE" server/csharp server/java server/python --include=*.cs --include=*.java --include=*.py
```

Read each one before editing. Each port already has this rule; you are adding the array condition beside it and adding the sortable pass after it.

- [ ] **Step 2: Use each port's RESOLVING array accessor**

This is the single highest-risk detail. Do **not** read a raw `isArray` field or a raw attr.

| Port | Correct accessor |
|---|---|
| TypeScript | `field.resolvedIsArray()` |
| Python | `node.resolved_is_array()` |
| C# / Java | grep the port's existing `@agg:collect` array check — it already reads array-ness the resolving way; copy that call exactly |

For C# and Java:

```bash
grep -rn "collect produces a list" server/csharp server/java
```

The line above that error is the resolving accessor to reuse.

- [ ] **Step 3: Implement in each port**

Mirror the TypeScript semantics exactly:
- `@filterable: true` + array ⇒ `ERR_FILTERABLE_UNSUPPORTED_SUBTYPE`
- `@sortable: true` + (array **or** no operator band) ⇒ `ERR_SORTABLE_UNSUPPORTED_SUBTYPE`
- Neither fires when the attr is absent or `false`.

- [ ] **Step 4: Run each port's conformance suite**

```bash
cd server/python && uv run pytest --extra integration -k conformance
cd server/csharp && dotnet build && dotnet test --filter "FullyQualifiedName~Conformance"
cd server/java && mvn -q -pl metadata test
```

Expected: all green on the two new fixtures.

**Two traps, both previously shipped:** `dotnet test` prints `Passed!` even when a project failed to COMPILE — grep the output for `error CS` and confirm the build succeeded separately. Never pipe a Maven run through `tail`; the exit status becomes `tail`'s.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects/Loader/ValidationPasses.cs \
        server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java \
        server/python/src/metaobjects/loader/validation_passes.py
git commit -m "fix(metamodel): array filter/sort rules in the remaining three ports (#335)"
```

---

## Task 5: Half A — `@of` optional on `collect` (TypeScript loader)

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts` — the block under the comment `// --- count/sum/avg/min/max/collect: @of REQUIRED ---`
- Test: `server/typescript/packages/metadata/test/validation-collect-whole-object.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Half B (independent rules, same file).
- Produces: the `@of`-absent collect branch. Task 6 adds member resolution; Task 8 ports it.

**Why:** Today `@of` is required for `collect`, so only a single scalar column can be rolled up. `@of` is already `"required": false` in the registry — the constraint is validation-only.

> ### CORRECTION — use this model, not the one written below
>
> The model in Step 1 is **wrong** and was verified so by execution. It produces two structural
> errors that have nothing to do with #335: `ERR_SUBTYPE_RULE_VIOLATION` (*"a projection may
> only extend another projection"* — it has `object.projection extends "Product"`, an entity)
> and `ERR_PROJECTION_IDENTITY_NOT_EXTENDED` (a projection identity must `extends` an entity
> identity, not declare fresh `@fields`).
>
> Use this shape instead — copied from the corpus's own `error-origin-aggregate-no-to-many`
> and **verified**: the scalar baseline loads with **0 errors**, and the whole-object form
> produces **exactly one** error, `ERR_INVALID_ORIGIN … missing @of`.
>
> ```jsonc
> { "object.projection": { "name": "ProductWithSuppliers", "children": [
>     { "field.uuid": { "name": "productId", "extends": "acme::Product.id" } },
>     <the collect field under test>,
>     { "identity.primary": { "name": "id", "extends": "acme::Product.id" } }
> ]}}
> ```
>
> The projection carries **no** object-level `extends`; each field carries its own, and the
> identity uses `extends` rather than `@fields`. Entities are plain: `source.rdb @table`,
> `field.uuid id`, `identity.primary { name: "id", @fields: ["id"] }`, and `Product` holds
> `relationship.association { name: "suppliers", @objectRef: "acme::Supplier", @cardinality: "many" }`.
>
> Also note: `MetaDataLoader.load()` is **async** and returns errors on the result — it does
> not throw. `await` it. Copy the exact harness from
> `server/typescript/packages/metadata/test/validation-filterable-array.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/validation-collect-whole-object.test.ts`. Include a **positive** case and each **negative** arm:

```ts
import { test, expect, describe } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

/** Product 1:N Supplier, plus a projection rolling suppliers up as objects. */
const model = (collectField: string, extra = "") => `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": { "name": "Supplier", "children": [
          { "source.rdb": { "@kind": "table", "@table": "suppliers" } },
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "name" } },
          { "field.long": { "name": "productId" } },
          { "identity.primary": { "@fields": ["id"] } },
          { "identity.reference": { "name": "product", "@references": "Product", "@fields": ["productId"] } }
      ]}},
      { "object.entity": { "name": "Product", "children": [
          { "source.rdb": { "@kind": "table", "@table": "products" } },
          { "field.long": { "name": "id" } },
          { "identity.primary": { "@fields": ["id"] } },
          { "relationship.association": { "name": "suppliers", "@cardinality": "many", "@objectRef": "Supplier" } }
      ]}},
      { "object.value": { "name": "SupplierBrief", "children": [
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "name" } }
      ]}},
      ${extra}
      { "object.projection": { "name": "ProductWithSuppliers", "extends": "Product", "children": [
          { "source.rdb": { "@kind": "view", "@view": "v_product_suppliers" } },
          { "identity.primary": { "@fields": ["id"] } },
          ${collectField}
      ]}}
    ]
  }
}`;

const load = (src: string) => new MetaDataLoader().loadFromString(src, "meta.demo.json");

const WHOLE_OBJECT = `{ "field.object": {
    "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
    "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } } ]
}}`;

describe("@of-absent collect (whole-object rollup)", () => {
  test("loads on a field.object @objectRef isArray with @via", () => {
    expect(() => load(model(WHOLE_OBJECT))).not.toThrow();
  });

  test("fails without @objectRef", () => {
    expect(() => load(model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true,
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } } ]
    }}`))).toThrow(/ERR_INVALID_ORIGIN/);
  });

  test("fails when @objectRef targets an entity, not a value", () => {
    expect(() => load(model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "Supplier",
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } } ]
    }}`))).toThrow(/ERR_SUBTYPE_RULE_VIOLATION/);
  });

  test("fails without @via (nothing to infer the relation from)", () => {
    expect(() => load(model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
      "children": [ { "origin.aggregate": { "@agg": "collect" } } ]
    }}`))).toThrow(/ERR_INVALID_ORIGIN/);
  });

  test("fails when @distinct is declared", () => {
    expect(() => load(model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers", "@distinct": true } } ]
    }}`))).toThrow(/ERR_INVALID_ORIGIN/);
  });

  test("a collect WITH @of is unaffected", () => {
    expect(() => load(model(`{ "field.string": {
      "name": "supplierNames", "isArray": true,
      "children": [ { "origin.aggregate": { "@agg": "collect", "@of": "Supplier.name", "@via": "Product.suppliers" } } ]
    }}`))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server/typescript/packages/metadata && bun test test/validation-collect-whole-object.test.ts
```

Expected: the positive cases FAIL with `missing @of`; the negatives may pass for the wrong reason. That is fine — Step 3 makes all six correct.

- [ ] **Step 3: Split `collect` out of the `@of`-required gate**

Replace the block beginning `// --- count/sum/avg/min/max/collect: @of REQUIRED ---` with:

```ts
          // --- @of: REQUIRED for count/sum/avg/min/max; OPTIONAL for collect ---
          // #335 — an @of-absent collect is a WHOLE-OBJECT rollup: collect the
          // related rows as an array of the field's declared @objectRef value
          // object rather than an array of one scalar column.
          if (!ofPresent) {
            if (!isCollect) {
              errors.push(new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @of.`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
              continue;
            }
            // Whole-object rollup. The carrying field must be a field.object
            // naming a value object, and @via must be explicit (there is no @of
            // entity to infer the single-hop relation from).
            // ADR-0039: resolving — @objectRef may be inherited via extends.
            const objectRef = field.attr(FIELD_ATTR_OBJECT_REF);
            if (field.subType !== FIELD_SUBTYPE_OBJECT || typeof objectRef !== "string" || objectRef === "") {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @of is omitted, so this is a ` +
                  `whole-object rollup — the carrying field must be a field.object declaring @objectRef ` +
                  `(add @of to collect a single column instead).`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
              continue;
            }
            // #210's value-only rule is PAYLOAD-scoped and never reaches a
            // projection-hosted field, so this branch enforces it itself.
            // Without it an @objectRef to an entity silently rolls up the FULL
            // entity — the #270 shape, this time baked into DDL.
            const refPkg = field.parent?.package ?? obj.package ?? "";
            const refTarget = resolveObjectRef(root, objectRef, refPkg).node;
            if (refTarget !== undefined && refTarget.subType !== OBJECT_SUBTYPE_VALUE) {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @objectRef '${objectRef}' ` +
                  `resolves to ${TYPE_OBJECT}.${refTarget.subType} — a whole-object rollup must target an ` +
                  `object.value (#210, ADR-0028).`,
                { code: "ERR_SUBTYPE_RULE_VIOLATION", source: src }));
              continue;
            }
            // ADR-0039: own — origin.* never inherits (ADR-0029).
            const viaAttr = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
            if (typeof viaAttr !== "string" || viaAttr === "") {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @via is required on a ` +
                  `whole-object rollup — there is no @of entity to infer the relationship from.`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
              continue;
            }
            // @distinct is refused on the object form. It is NOT an engine limit
            // (both engines dedupe JSON objects); it is a guaranteed no-op
            // whenever the value object carries the entity's primary key, which
            // is the common case, and a silent no-op is worse than a refusal.
            if (hasDistinct) {
              errors.push(new ParseError(
                `origin.aggregate @agg:collect on ${obj.name}.${field.name}: @distinct is not supported on a ` +
                  `whole-object rollup (it is a no-op whenever the value object carries the primary key).`,
                { code: "ERR_INVALID_ORIGIN", source: src }));
              continue;
            }
            const hops = _validateViaPath(viaAttr, root, obj, field.name, src, errors);
            if (hops !== undefined) _checkAggregateCardinality(hops, obj, field.name, src, errors);
            // @orderBy keys resolve against the @via TERMINAL entity, not @of.
            if (hasOrderBy) {
              const terminal = _viaTerminalEntityNode(viaAttr, root, obj);
              _validateOrderByKeys(orderBy, terminal, obj, field.name, "origin.aggregate @agg:collect", src, errors);
            }
            continue;
          }
```

Add a `_viaTerminalEntityNode` helper beside `_validateViaPath` that walks the same dotted `@via` segments and returns the terminal entity node (or `undefined`). `extract-view-spec.ts:477` has the codegen-side equivalent (`viaTerminalEntity`) — mirror its hop-walking logic, returning the loader's node type.

Import any constants not already imported (`FIELD_SUBTYPE_OBJECT`, `FIELD_ATTR_OBJECT_REF`, `OBJECT_SUBTYPE_VALUE`, `resolveObjectRef`).

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server/typescript/packages/metadata && bun test test/validation-collect-whole-object.test.ts
```

Expected: 6 pass, 0 fail.

- [ ] **Step 5: Run the full metadata suite**

```bash
cd server/typescript/packages/metadata && bun test
```

Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts \
        server/typescript/packages/metadata/test/validation-collect-whole-object.test.ts
git commit -m "feat(metamodel): @of is optional on @agg:collect — whole-object rollup (#335)"
```

---

## Task 6: Half A — value-object member resolution (the #270 guard)

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts` (the branch from Task 5)
- Modify: the five error ledgers (as in Task 2, Step 3)
- Test: `server/typescript/packages/metadata/test/validation-collect-member-resolution.test.ts` (create)

**Interfaces:**
- Consumes: Task 5's `@of`-absent branch and its `_viaTerminalEntityNode` helper.
- Produces: `ERR_COLLECT_MEMBER_UNRESOLVED`. Task 10's emitter relies on every member resolving.

**Why:** The lowering projects exactly the declared value-object's members. A member that matches no column on the `@via` terminal entity must be an **error** — failing open here is how #270 turned a curated value object into the full entity. Element type stays declared-authoritative.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/validation-collect-member-resolution.test.ts`, reusing the model helper from Task 5 (copy it — the engineer may read tasks out of order) with two cases:

```ts
  test("a VO member with no matching column on the @via terminal fails", () => {
    // SupplierBrief declares `nickname`; Supplier has no such field.
    expect(() => load(modelWithVo(
      `{ "field.long": { "name": "id" } }, { "field.string": { "name": "nickname" } }`,
      WHOLE_OBJECT,
    ))).toThrow(/ERR_COLLECT_MEMBER_UNRESOLVED/);
  });

  test("a VO member whose type differs from the matched column fails", () => {
    // SupplierBrief declares `name` as a long; Supplier.name is a string.
    expect(() => load(modelWithVo(
      `{ "field.long": { "name": "id" } }, { "field.long": { "name": "name" } }`,
      WHOLE_OBJECT,
    ))).toThrow(/ERR_INVALID_ORIGIN/);
  });
```

Write `modelWithVo(voFields, collectField)` as a variant of Task 5's `model` that parameterises `SupplierBrief`'s field list.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server/typescript/packages/metadata && bun test test/validation-collect-member-resolution.test.ts
```

Expected: both FAIL (nothing thrown).

- [ ] **Step 3: Add `ERR_COLLECT_MEMBER_UNRESOLVED` to all five ledgers**

Same five files as Task 2, Step 3.

- [ ] **Step 4: Implement member resolution**

Inside Task 5's branch, after the `@via` hop validation and before its `continue`:

```ts
            // Member resolution — the lowering projects EXACTLY the declared value
            // object's members, matched by NAME against the @via terminal entity.
            // An unmatched member must error: failing open is how #270 turned a
            // curated value object into the full entity.
            const terminalEntity = _viaTerminalEntityNode(viaAttr, root, obj);
            if (terminalEntity !== undefined && refTarget !== undefined) {
              // children() — a value object may inherit members via extends.
              const terminalFields = terminalEntity.children().filter((c) => c.type === TYPE_FIELD);
              for (const member of refTarget.children().filter((c) => c.type === TYPE_FIELD)) {
                const match = terminalFields.find((f) => f.name === member.name);
                if (match === undefined) {
                  errors.push(new ParseError(
                    `origin.aggregate @agg:collect on ${obj.name}.${field.name}: value-object member ` +
                      `'${member.name}' has no matching field on '${terminalEntity.name}' — a whole-object ` +
                      `rollup projects exactly the declared members.`,
                    { code: "ERR_COLLECT_MEMBER_UNRESOLVED", source: src }));
                  continue;
                }
                // Per-member type agreement — the object-form analogue of the
                // scalar element-type check, same #185 type-preserving doctrine.
                if (member.subType !== match.subType) {
                  errors.push(new ParseError(
                    `origin.aggregate @agg:collect on ${obj.name}.${field.name}: value-object member ` +
                      `'${member.name}' is field.${member.subType} but '${terminalEntity.name}.${match.name}' ` +
                      `is field.${match.subType} — a whole-object rollup preserves each member's type.`,
                    { code: "ERR_INVALID_ORIGIN", source: src }));
                }
              }
            }
```

- [ ] **Step 5: Run both Half A tests**

```bash
cd server/typescript/packages/metadata && bun test test/validation-collect-member-resolution.test.ts test/validation-collect-whole-object.test.ts
```

Expected: 8 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/loader/validation-passes.ts \
        server/typescript/packages/metadata/src/errors.ts \
        server/typescript/packages/metadata/test/validation-collect-member-resolution.test.ts \
        fixtures/conformance/ERROR-CODES.json \
        server/python/src/metaobjects/errors.py \
        server/java/metadata/src/main/java/com/metaobjects/ErrorCode.java \
        server/csharp/MetaObjects/Errors.cs
git commit -m "feat(metamodel): whole-object rollup resolves VO members against the @via terminal (#335)"
```

---

## Task 7: Half A — conformance fixtures (positive + 6 negative arms)

**Files:**
- Create: `fixtures/conformance/collect-whole-object/{input/meta.demo.json,expected.json}`
- Create: six `fixtures/conformance/error-collect-*/` directories, each with `input/meta.demo.json` + `expected-errors.json`
- Modify: `fixtures/conformance/README.md`

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces: the cross-port contract Task 8 implements against.

The six negative arms, one fixture each:

| Fixture | Arm | Code |
|---|---|---|
| `error-collect-no-object-ref` | no `@objectRef` | `ERR_INVALID_ORIGIN` |
| `error-collect-ref-not-value` | `@objectRef` → entity | `ERR_SUBTYPE_RULE_VIOLATION` |
| `error-collect-no-via` | `@via` absent | `ERR_INVALID_ORIGIN` |
| `error-collect-via-to-one` | every hop to-one | `ERR_ORIGIN_CARDINALITY` |
| `error-collect-member-unresolved` | VO member not on terminal | `ERR_COLLECT_MEMBER_UNRESOLVED` |
| `error-collect-distinct` | `@distinct` declared | `ERR_INVALID_ORIGIN` |

- [ ] **Step 1: Build the positive fixture**

Use the model from Task 5's test as `input/meta.demo.json`. Generate `expected.json` by running the corpus and copying the canonical serialization the runner prints on mismatch — **do not hand-write it**.

- [ ] **Step 2: Build the six negative fixtures**

Each is the positive input with one thing changed. Copy the `expected-errors.json` shape from `fixtures/conformance/error-origin-aggregate-no-to-many/expected-errors.json`; take the `jsonPath` from the runner's failure output rather than deriving it.

- [ ] **Step 3: Run the corpus**

```bash
cd server/typescript/packages/metadata && bun test test/conformance.test.ts
```

Expected: PASS, count increased by 7.

- [ ] **Step 4: Document in the README**

Add all seven to the case list. For the positive one, state that it is the corpus's only whole-object rollup.

- [ ] **Step 5: Commit**

```bash
git add fixtures/conformance/collect-whole-object fixtures/conformance/error-collect-* fixtures/conformance/README.md
git commit -m "test(conformance): gate the whole-object rollup and its six error arms (#335)"
```

---

## Task 8: Half A — port the loader rules to C#, Java, Python

**Files:**
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java`
- Modify: `server/python/src/metaobjects/loader/validation_passes.py`

**Interfaces:**
- Consumes: Tasks 5–7. The seven fixtures are the contract.
- Produces: four ports green on the whole corpus.

- [ ] **Step 1: Locate each port's gate**

```bash
grep -rn "missing @of" server/csharp server/java server/python
```

Python phrases it differently — search for its `AGG_COLLECT` handling near the `collect produces a list` message instead.

- [ ] **Step 2: Implement the same six rules per port**

Object-ref required; ref must be `object.value`; `@via` required; cardinality; member resolution; `@distinct` refused. Use each port's **resolving** accessors throughout (see Task 4, Step 2).

- [ ] **Step 3: Run each port's conformance suite**

```bash
cd server/python && uv run pytest --extra integration -k conformance
cd server/csharp && dotnet build && dotnet test --filter "FullyQualifiedName~Conformance"
cd server/java && mvn -q -pl metadata test
```

Expected: green on all seven new fixtures. Same two traps as Task 4, Step 4.

- [ ] **Step 4: Commit**

```bash
git add server/csharp/MetaObjects/Loader/ValidationPasses.cs \
        server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java \
        server/python/src/metaobjects/loader/validation_passes.py
git commit -m "feat(metamodel): whole-object rollup in the remaining three ports (#335)"
```

---

## Task 9: Half A — registry prose in seven byte-gated files

**Files:** the seven listed under **File Structure**.

**Interfaces:**
- Consumes: Tasks 5–8 (the rule the prose describes).
- Produces: `registry-conformance` green in all five ports.

**Why:** `@of` is already `"required": false` structurally, so nothing changes there — but its `description` says *"Required for count/sum/avg/min/max/collect"*, which is now false. That string is byte-gated in seven files; change fewer than seven and `registry-conformance` goes red in whichever port you missed.

- [ ] **Step 1: Find every copy**

```bash
grep -rln "Required for count/sum/avg/min/max/collect" . --exclude-dir=docs
```

Expected: exactly **7 product files** — the seven listed under **File Structure**.

**Exclude `docs/superpowers/`.** Without that flag the grep returns **9**, because this plan and
its spec both quote the sentence. Verified. Editing those two is harmless but pointless; they
are prose about the change, not copies of the contract.

- [ ] **Step 2: Rewrite the sentence identically in all seven**

New text, byte-identical everywhere:

```
Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes'). Required for count/sum/avg/min/max; OPTIONAL for collect, where absent means a whole-object rollup of the field's declared @objectRef value object; forbidden for any/all (which quantify over rows via @filter, not a column).
```

- [ ] **Step 3: Regenerate the derived docs fixture**

`fixtures/metamodel-docs/expected/types/origin.md` is generated. Find its generator command in `fixtures/metamodel-docs/README.md` and run it rather than hand-editing.

- [ ] **Step 4: Run registry conformance in every port**

```bash
cd server/typescript/packages/metadata && bun test test/registry-conformance.test.ts
cd server/python && uv run pytest --extra integration -k registry
cd server/csharp && dotnet build && dotnet test --filter "FullyQualifiedName~Registry"
cd server/java && mvn -q -pl metadata test -Dtest='*Registry*'
```

Expected: all green.

- [ ] **Step 5: Confirm `metamodelVersion` still needs no move**

```bash
node scripts/check-metamodel-version.mjs --explain
git tag --list 'v0.*' --sort=-v:refname | head -1
```

If the newest release tag is still `v0.24.0`, `0.11` is unreleased and no edit is needed. If `v0.24.1` has shipped, run `node scripts/check-metamodel-version.mjs --set 0.12`.

- [ ] **Step 6: Commit**

```bash
git add spec/metamodel/origin.json fixtures/registry-conformance/expected-registry.json \
        fixtures/metamodel-docs/expected/types/origin.md \
        server/csharp/MetaObjects/Persistence/Origin/OriginSchema.cs \
        server/csharp/MetaObjects/SpecMetamodel/origin.json \
        server/python/src/metaobjects/spec_metamodel/origin.json \
        server/typescript/packages/metadata/src/persistence/origin/origin-definition.embedded.ts
git commit -m "docs(metamodel): @of is optional on collect, in all seven byte-gated copies (#335)"
```

---

## Task 10: Half A — the `collectObjectAgg` view column (TypeScript codegen)

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/view-spec.ts`
- Modify: `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts`
- Test: `server/typescript/packages/codegen-ts/test/projection/collect-whole-object-spec.test.ts` (create)

**Interfaces:**
- Consumes: the loader guarantees from Tasks 5–8 (every member resolves; `@objectRef` is a value; `@via` present).
- Produces:

```ts
{
  readonly kind: "collectObjectAgg";
  readonly fieldName: string;
  readonly dbColAlias: string;
  readonly sourceAlias: string;
  readonly joinedPkColumn: string;
  readonly members: readonly { readonly memberName: string; readonly sourceColumn: string }[];
  readonly orderBy: readonly ViewOrderKey[];
}
```

Task 11 lowers this to SQL.

**Why a separate kind, not an arm of `collectAgg`:** the payloads differ (a member list vs one source column), and `collectAgg` is consumed by `viewOrderKeysAreDeterministic` (`:1005`) and the real-aggregate predicate (`:1021`), which a union would force every consumer to re-narrow.

- [ ] **Step 1: Add the kind to `view-spec.ts`**

Add the interface above to the `ViewColumn` union, beside the existing `collectAgg` member.

- [ ] **Step 2: Write the failing test**

Create the test file; build the same Product/Supplier/SupplierBrief model as Task 5, run `extractViewSpec`, and assert:

```ts
    const col = spec.columns.find((c) => c.fieldName === "supplierBriefs");
    expect(col?.kind).toBe("collectObjectAgg");
    expect(col?.members).toEqual([
      { memberName: "id", sourceColumn: "id" },
      { memberName: "name", sourceColumn: "name" },
    ]);
    expect(col?.orderBy).toEqual([]);          // default = PK asc, applied at emit
    expect(col?.joinedPkColumn).toBe("id");
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd server/typescript/packages/codegen-ts && bun test test/projection/collect-whole-object-spec.test.ts
```

Expected: FAIL — the column is absent entirely, because `if (!of_) continue;` skips it.

- [ ] **Step 4: Restructure the branch**

In `extract-view-spec.ts`, the `if (!of_) continue;` at ~`:891` sits **above** the `AGG_COLLECT` branch and must no longer swallow the object form. Add the object arm **before** that guard, mirroring the `any`/`all` branch at `:861-885`:

```ts
      // #335 — @of ABSENT on collect is a whole-object rollup. Resolve the related
      // entity from @via's terminal hop (not from @of), exactly as any/all does.
      if (agg === AGG_COLLECT && !of_) {
        const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined;
        if (!via) continue;                                   // loader already errored
        const objectRef = field.attr(FIELD_ATTR_OBJECT_REF) as string | undefined;
        if (!objectRef) continue;                             // loader already errored
        const relatedName = viaTerminalEntity(via, root, projPkg);
        if (!relatedName) continue;
        const relatedEntity = resolveEntityRef(root, relatedName, projPkg);
        const sourceAlias = findAliasInTree(joinTree, relatedName);
        if (!relatedEntity || sourceAlias === undefined) continue;
        const joinedPk = primaryKeyColumn(relatedEntity, ctx);
        if (joinedPk === undefined) continue;
        const vo = resolveObjectRef(root, objectRef, projPkg).node;
        if (!vo) continue;
        // children() — a value object may inherit members via extends.
        const members = vo.children()
          .filter((c): c is MetaField => c.type === TYPE_FIELD)
          .map((m) => {
            const target = relatedEntity.fields().find((f) => f.name === m.name);
            // The loader guarantees every member resolves (ERR_COLLECT_MEMBER_UNRESOLVED).
            return target === undefined
              ? undefined
              : { memberName: m.name, sourceColumn: sourceColumnNameFor(target, ctx) };
          })
          .filter((m): m is { memberName: string; sourceColumn: string } => m !== undefined);
        if (members.length === 0) continue;
        columns.push({
          kind: "collectObjectAgg",
          fieldName: field.name,
          dbColAlias: dbCol,
          sourceAlias,
          joinedPkColumn: joinedPk,
          members,
          orderBy: resolveOrderByKeys(origin.ownAttr(ORIGIN_ATTR_ORDER_BY), relatedEntity, ctx),
        });
        continue;
      }
```

Then update `:1005` and `:1021` to treat `collectObjectAgg` the same way they treat `collectAgg` (deterministic ordering; a real aggregate).

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server/typescript/packages/codegen-ts && bun test test/projection/collect-whole-object-spec.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/projection/view-spec.ts \
        server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts \
        server/typescript/packages/codegen-ts/test/projection/collect-whole-object-spec.test.ts
git commit -m "feat(codegen-ts): extract a collectObjectAgg column from an @of-less collect (#335)"
```

---

## Task 11: Half A — SQL lowering, both dialects

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/view-ddl-emit.ts`
- Test: `server/typescript/packages/codegen-ts/test/projection/collect-whole-object-ddl.test.ts` (create)

**Interfaces:**
- Consumes: Task 10's `collectObjectAgg`.
- Produces: the emitted SQL Task 13 applies to real engines.

**Why `jsonb`, not `json`:** verified against PostgreSQL 15.15 — `json` has neither an equality nor an ordering operator (`ERROR: operator does not exist: json = json`; `could not identify an ordering operator for type json`), so `json_agg(json_build_object(…) ORDER BY …)` **does not run**. `field.object` is already `jsonb` in `column-mapper.ts:610-613`.

- [ ] **Step 1: Write the failing test**

```ts
  test("postgres: jsonb_agg of jsonb_build_object, PK-asc, empty-set guarded", () => {
    expect(emitColumn(col, "postgres")).toBe(
      `COALESCE(jsonb_agg(jsonb_build_object('id', s."id", 'name', s."name") ORDER BY s."id" ASC) ` +
      `FILTER (WHERE s."id" IS NOT NULL), '[]'::jsonb) AS "supplierBriefs"`,
    );
  });

  test("sqlite: json_group_array of json_object, PK-asc, empty-set guarded", () => {
    expect(emitColumn(col, "sqlite")).toBe(
      `COALESCE(json_group_array(json_object('id', s."id", 'name', s."name") ORDER BY s."id" ASC) ` +
      `FILTER (WHERE s."id" IS NOT NULL), json_array()) AS "supplierBriefs"`,
    );
  });
```

Match `emitColumn`'s real name and signature from the neighbouring tests in that directory.

- [ ] **Step 2: Run to verify it fails**

```bash
cd server/typescript/packages/codegen-ts && bun test test/projection/collect-whole-object-ddl.test.ts
```

Expected: FAIL — no branch handles the kind.

- [ ] **Step 3: Implement the lowering**

In `view-ddl-emit.ts`, directly after the `collectAgg` branch at `:187`:

```ts
  if (c.kind === "collectObjectAgg") {
    const guard = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)} IS NOT NULL`;
    // Element order: the related entity's PK ascending by default — "value
    // ascending" is meaningless for an object and does not even parse on PG json.
    // An explicit @orderBy leads, with the PK appended as tie-break so equal-order
    // rows stay byte-deterministic (mirrors renderFirst at :131-137). The SCALAR
    // arm deliberately keeps its no-tie-break behaviour: changing it would alter
    // emitted SQL for every existing project using @orderBy.
    const pk = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)}`;
    const orderClause = c.orderBy.length > 0
      ? `ORDER BY ${renderOrderKeys(c.orderBy, c.sourceAlias)}, ${pk} ASC`
      : `ORDER BY ${pk} ASC`;
    const pairs = c.members
      .map((m) => `'${m.memberName}', ${c.sourceAlias}.${quoteIfNeeded(m.sourceColumn)}`)
      .join(", ");
    if (dialect === "sqlite") {
      return `COALESCE(json_group_array(json_object(${pairs}) ${orderClause}) FILTER (WHERE ${guard}), json_array()) AS ${alias}`;
    }
    return `COALESCE(jsonb_agg(jsonb_build_object(${pairs}) ${orderClause}) FILTER (WHERE ${guard}), '[]'::jsonb) AS ${alias}`;
  }
```

In-aggregate `ORDER BY` needs SQLite **≥ 3.44**. Not a new constraint: the existing scalar `collect` already emits it and D1's baseline is pinned at `3.44.0` (`introspect/d1.ts:44`).

- [ ] **Step 4: Run to verify it passes**

```bash
cd server/typescript/packages/codegen-ts && bun test test/projection/collect-whole-object-ddl.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Add the scalar no-churn pin**

In the same file, add a test asserting a `collect` **with** `@of` still emits `array_agg(… ORDER BY … ) FILTER (…) , '{}'` on Postgres and `json_group_array` / `json_array()` on SQLite, byte-for-byte. The two arms share a branch neighbourhood; this is what proves the scalar one did not move.

- [ ] **Step 6: Run the whole codegen-ts suite**

```bash
cd server/typescript/packages/codegen-ts && bun test
```

Expected: 0 fail. If `issue-214-read-half-compile.test.ts` fails with *"Cannot find module `@metaobjectsdev/runtime-ts/drizzle-fastify`"*, that is a fresh-worktree precondition, not your change — run `bun run --filter '@metaobjectsdev/runtime-ts' build` from the repo root first.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/projection/view-ddl-emit.ts \
        server/typescript/packages/codegen-ts/test/projection/collect-whole-object-ddl.test.ts
git commit -m "feat(codegen-ts): lower a whole-object rollup to jsonb_agg / json_group_array (#335)"
```

---

## Task 12: Half A — real-engine round-trip, both dialects

**Files:**
- Modify: `server/typescript/packages/integration-tests/test/view-lifecycle-pg.test.ts`
- Modify: `server/typescript/packages/integration-tests/test/view-lifecycle-sqlite.test.ts`

**Interfaces:**
- Consumes: Tasks 10–11.
- Produces: the only evidence that counts for new DDL.

**Why:** Golden SQL is not acceptable evidence for new DDL — that is exactly how the migrate defect class got through before. These files live in a **separate package** that only the `ts-slow` lane runs; they will not appear in a `codegen-ts` or `migrate-ts` run.

- [ ] **Step 1: Add the projection to both fixtures**

Extend the existing model in each file with `SupplierBrief`, a `Supplier` child table, and a `field.object isArray @objectRef` carrying an `@of`-less collect — beside the existing `weekLabels` scalar collect, so both arms are exercised in one view.

- [ ] **Step 2: Assert emit → apply → introspect → re-diff is EMPTY**

Follow the existing round-trip in each file exactly. The re-diff must produce **no** operations; a non-empty second diff means the emitted SQL and the introspected schema disagree, which is permanent false drift on every subsequent `meta migrate`.

- [ ] **Step 3: Assert the value shape, including the empty set**

```ts
    // two related rows → array of objects, PK-ascending
    expect(JSON.parse(full.supplierBriefs)).toEqual([
      { id: 1, name: "Acme" },
      { id: 2, name: "Globex" },
    ]);
    // zero related rows → [] and NOT null (the FILTER guard)
    expect(JSON.parse(empty.supplierBriefs)).toEqual([]);
```

On Postgres the driver may return a parsed object rather than a string; match whatever the neighbouring `weekLabels` assertions do in that same file.

- [ ] **Step 4: Run both**

```bash
cd server/typescript/packages/integration-tests && bun test test/view-lifecycle-sqlite.test.ts
cd server/typescript/packages/integration-tests && bun test test/view-lifecycle-pg.test.ts
```

Postgres needs Docker for Testcontainers. If the container times out, re-run on a quiet box before treating it as a failure — that timeout fires before test logic and means load, not regression. **Never** point these at an existing local Postgres; print the resolved URL first and confirm it is the Testcontainers one.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/integration-tests/test/view-lifecycle-pg.test.ts \
        server/typescript/packages/integration-tests/test/view-lifecycle-sqlite.test.ts
git commit -m "test(integration): round-trip the whole-object rollup on real PG and SQLite (#335)"
```

---

## Task 13: Half A — restore the corpus coverage the retirement lost

**Files:**
- Modify: `fixtures/conformance/flattened-kitchen-sink/input/meta.catalog.json`
- Modify: `fixtures/conformance/flattened-kitchen-sink/expected.json`
- Modify: `fixtures/conformance/flattened-kitchen-sink/expected-effective.json`
- Modify: `fixtures/conformance/README.md`
- Modify: `docs/features/migrations/origin-collection-retirement.md`

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces: closes the documented coverage gap.

**Why:** `fixtures/conformance/README.md:102` records this as *"coverage genuinely lost"* — `flattened-kitchen-sink` dropped `supplierBriefs`, the corpus's only array-of-value-object carrying an origin — and names #335 as the restore path.

- [ ] **Step 1: Restore `supplierBriefs`, expressed the new way**

```jsonc
{ "field.object": {
    "name": "supplierBriefs", "isArray": true,
    "@objectRef": "acme::catalog::SupplierBrief",
    "children": [
      { "origin.aggregate": { "@agg": "collect", "@via": "acme::catalog::Product.suppliers" } }
    ]
}}
```

- [ ] **Step 2: Regenerate both goldens**

Run the corpus and copy the canonical output from the mismatch report. Do not hand-edit.

- [ ] **Step 3: Update the README's coverage table**

The "Coverage genuinely lost" entry is no longer true. Replace it with a line saying the shape is expressible again via `@of`-less collect and naming this fixture as where it is covered.

- [ ] **Step 4: Fix the retirement guide's silent case**

`docs/features/migrations/origin-collection-retirement.md:62-65` tells authors to *"delete the `origin.collection` child and change nothing else"*. That is correct for a **payload** host but wrong for a **view-kind projection**, where a no-origin field lowers to `SELECT base."supplierBriefs"` against a column that does not exist (`extract-view-spec.ts:817-826`). Add a short subsection: on a projection host, replace the child with `origin.aggregate @agg: collect @via: …` rather than deleting it.

- [ ] **Step 5: Run the corpus in every port**

```bash
cd server/typescript/packages/metadata && bun test test/conformance.test.ts
cd server/python && uv run pytest --extra integration -k conformance
cd server/csharp && dotnet build && dotnet test --filter "FullyQualifiedName~Conformance"
cd server/java && mvn -q -pl metadata test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add fixtures/conformance/flattened-kitchen-sink fixtures/conformance/README.md \
        docs/features/migrations/origin-collection-retirement.md
git commit -m "test(conformance): restore the array-of-value-object origin coverage (#335)"
```

---

## Task 14: Documentation and changelog

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/features/downstream-metadata-decisions.md`
- Modify: `agent-context/skills/metaobjects-authoring/SKILL.md` **and its 5 byte-gated copies** under `fixtures/agent-context-conformance/*/expected/.claude/skills/metaobjects-authoring/SKILL.md`

**Interfaces:**
- Consumes: everything.
- Produces: the adopter-facing record.

**Why the skill matters:** the skill is what teaches adopters the vocabulary. #342 shipped with the skill teaching a form the loader had just made illegal — do not repeat that in the other direction by leaving the skill unable to express the new one.

- [ ] **Step 1: Add the changelog entry**

Cover, in this order: the whole-object rollup with a worked example; **Half B as potentially breaking**, stated with its bounds — in-repo cost measured at zero, what breaks was already emitting SQL that cannot execute, and no documentation ever taught the form; the `@distinct` refusal as a deliberate choice rather than an engine limit; and the `metamodelVersion` position.

- [ ] **Step 2: Add the authoring-skill section**

Document `@of`-less collect beside the existing scalar `collect`: the `field.object isArray @objectRef` requirement, `@via` required, `@objectRef` must be an `object.value`, members must exist on the terminal entity with matching types, `@distinct` unsupported, default order PK-ascending.

- [ ] **Step 3: Regenerate the byte-gated skill copies**

```bash
grep -rn "regenerate" fixtures/agent-context-conformance/README.md
```

Run the generator named there. Do not hand-edit the five copies.

- [ ] **Step 4: Verify the agent-context corpus**

```bash
cd server/typescript/packages/cli && bun test
```

Expected: `agent-context-conformance` green.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/features/downstream-metadata-decisions.md \
        agent-context/skills/metaobjects-authoring/SKILL.md \
        fixtures/agent-context-conformance
git commit -m "docs: whole-object rollup and the array filter/sort rules (#335)"
```

---

## Task 15: Full-gate verification before merge

- [ ] **Step 1: Clean-tree check**

```bash
git clean -ndX    # review what would be removed
git clean -fdX && bun install
```

The dev box is warm; a lane change validated on a warm tree proves nothing.

- [ ] **Step 2: Run the affected ports**

```bash
bash scripts/ci-local.sh --only ts
bash scripts/ci-local.sh --only python
bash scripts/ci-local.sh --only csharp
bash scripts/ci-local.sh --only java
```

**Never pipe these through `tail`** — the exit status becomes `tail`'s and a red run reports green. Read the trailing `OK —` / `FAILED —` line directly.

- [ ] **Step 3: Confirm the scalar arm never moved**

```bash
git diff v0.24.0 --stat -- server/typescript/packages/codegen-ts/test/golden/
```

Expected: no churn attributable to the scalar `collect` path. Any golden that moved must be explained before merge.

- [ ] **Step 4: Leak scan**

```bash
bash scripts/ci-local.sh --quick
```

- [ ] **Step 5: Re-check the version question**

```bash
git tag --list 'v0.*' --sort=-v:refname | head -1
node scripts/check-metamodel-version.mjs --explain
```

If `v0.24.1` shipped while this was in flight, `--set 0.12` and commit before merging.

- [ ] **Step 6: Coordinate before pushing**

Another session owns `validation-passes.ts` for #342 and has committed there. `git fetch origin` and rebase before pushing; message that session before landing.

---

## Self-review

**Spec coverage.** A1 → Tasks 5, 8. A2 → Task 6. A3 → Task 10. A4 → Task 11. A5 → Tasks 5 (`@distinct`), 11 (order). A6 → Task 9. A7 → Tasks 9 Step 5, 15 Step 5. B1 → Tasks 1, 4. B2 → Tasks 2, 4. B3 → Task 14 Step 1. Testing section → Tasks 3, 7, 12, 13. Non-goals are not implemented, by design.

**Placeholders.** None. Every code step carries real code; every command is runnable.

**Type consistency.** `collectObjectAgg` and its `members: { memberName, sourceColumn }[]` are defined in Task 10 and consumed unchanged in Tasks 11–12. `_viaTerminalEntityNode` is introduced in Task 5 and reused in Task 6. `ERR_COLLECT_MEMBER_UNRESOLVED` and `ERR_SORTABLE_UNSUPPORTED_SUBTYPE` are added to all five ledgers in the tasks that first emit them.

**Known soft spots**, flagged rather than hidden: the loader's string entry point is written as `loadFromString`, and the DDL test helper as `emitColumn` — both must be matched to the real names in neighbouring tests. Task 9's exact seven files must come from the grep, not from the list, in case a copy moved.
