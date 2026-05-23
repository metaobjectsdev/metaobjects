# `field.enum` Datatype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `enum` as a first-class field datatype (subtype) across all language ports, with a required `@values` string-array attribute, idiomatic per-language codegen, and a portable DB `CHECK` constraint.

**Architecture:** `enum` is a new field subtype, a peer of `currency` in the flat subtype list — *not* a decorated string. The metamodel just names the type; its string storage/wire form lives entirely in codegen mappings, exactly as `currency` maps to integer. `@values` lists the member symbols (string-backed in v1). Reuse is via the existing abstract-field + `extends` mechanism (no new syntax). Members are restricted to identifier-safe symbols so symbol == stored value with no name↔value divergence.

**Tech Stack:** TS (Bun, `@metaobjectsdev/metadata` + `codegen-ts`, Drizzle/Zod), C# (.NET, EF Core, `MetaObjects.*`), Java (Gradle, `com.metaobjects`), Python (pytest, `metaobjects`). Shared conformance corpus at `fixtures/conformance/`.

**Design spec:** `docs/superpowers/specs/2026-05-23-enum-datatype-design.md`

---

## Conventions for this plan

- **TDD throughout:** failing test → run-it-fails → minimal impl → run-it-passes → commit.
- **All paths are repo-relative** from the repo root.
- **Commit messages** end with the trailer:
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
- **Use named constants** for every metamodel string — never inline `"enum"` or `"values"`.
- **Test runners:**
  - TS: `cd server/typescript && bun test`
  - C#: `cd server/csharp && dotnet test`
  - Python: `cd server/python && pytest`
  - Java: `cd server/java && ./gradlew :metadata:test`
- **Public-repo hygiene:** no private names or absolute local paths in any committed file.

## Scope note (read first)

- **TS and C#** get the full treatment: metamodel + codegen (types, validation, DDL).
- **Java and Python** get **metamodel recognition only** (subtype + `@values` so the loader accepts and the canonical serializer round-trips). Their codegen tiers aren't built yet; the *vocabulary contract* is what must land now.
- **Cross-language conformance fixtures cover only the happy path** (every port must pass them) plus the one universal negative (`@values` missing → `ERR_MISSING_REQUIRED_ATTR`, free from `required: true`). The **identifier-safety and duplicate-member** checks are custom rules; in v1 they are TS + C# **unit tests**, not shared fixtures, to avoid Java/Python known-gap bookkeeping. They graduate to shared error fixtures when those ports implement the checks.

---

## Phase 1 — Cross-language contract: happy-path conformance fixtures

These define the canonical output every port must produce. Written first; they fail until Phase 2 teaches the TS loader the `enum` subtype.

### Task 1.1: `enum-inline` fixture

**Files:**
- Create: `fixtures/conformance/enum-inline/input/meta.enums.json`
- Create: `fixtures/conformance/enum-inline/expected.json`

- [ ] **Step 1: Write the input fixture**

`fixtures/conformance/enum-inline/input/meta.enums.json`:
```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Order",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write the expected canonical output**

Canonical rules: `@`-attrs alphabetical within a node, `@fields` scalar→array, 2-space indent, trailing newline.

`fixtures/conformance/enum-inline/expected.json`:
```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      {
        "object.entity": {
          "name": "Order",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
        }
      }
    ]
  }
}
```
(Expand to the canonical pretty-printed form — 2-space indent, each array element on its own line — matching the style of `fixtures/conformance/identity-primary-and-secondary/expected.json`.)

- [ ] **Step 3: Run TS conformance to confirm it FAILS**

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "enum-inline"`
Expected: FAIL — `ERR_UNKNOWN_SUBTYPE` (loader doesn't know `field.enum` yet).

- [ ] **Step 4: Commit**

```bash
git add fixtures/conformance/enum-inline
git commit -m "test(conformance): add enum-inline happy-path fixture (red)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: `enum-abstract-extends` fixture (first field-to-field extends fixture)

**Files:**
- Create: `fixtures/conformance/enum-abstract-extends/input/meta.enums.json`
- Create: `fixtures/conformance/enum-abstract-extends/expected.json`
- Create: `fixtures/conformance/enum-abstract-extends/script.json`

- [ ] **Step 1: Write the input** — an abstract `field.enum` extended by a concrete field.

`fixtures/conformance/enum-abstract-extends/input/meta.enums.json`:
```json
{
  "metadata.root": {
    "package": "acme",
    "children": [
      { "field.enum": { "name": "Status", "abstract": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
      {
        "object.entity": {
          "name": "Order",
          "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "Status" } },
            { "identity.primary": { "@fields": "id" } }
          ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write `expected.json`** — declared-tree canonical output (own attrs only; the abstract field keeps `@values`, the concrete field keeps `extends` and does NOT inline inherited `@values`, matching how `extends-abstract-base/expected.json` keeps own children only). Mirror that fixture's shape exactly.

- [ ] **Step 3: Write `script.json`** to assert the concrete field resolves its inherited `@values` (effective view):
```json
{
  "operations": [
    {
      "navigate": ["object:Order", "field:status"],
      "invoke": "field.effective-attr",
      "args": { "name": "values" },
      "expect": { "value": ["DRAFT", "PUBLISHED", "ARCHIVED"] }
    }
  ]
}
```
(If no `field.effective-attr` capability exists yet, see Task 2.6 — add the capability + name in `CAPABILITIES.json`. If adding a capability is out of appetite, drop `script.json` and rely on the TS unit test in Task 2.5 for the inheritance assertion.)

- [ ] **Step 4: Run to confirm FAIL**

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "enum-abstract-extends"`
Expected: FAIL — unknown subtype.

- [ ] **Step 5: Commit**

```bash
git add fixtures/conformance/enum-abstract-extends
git commit -m "test(conformance): add enum-abstract-extends fixture (red)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: `enum-array` + `error-enum-missing-values` fixtures

**Files:**
- Create: `fixtures/conformance/enum-array/input/meta.enums.json` + `expected.json`
- Create: `fixtures/conformance/error-enum-missing-values/input/meta.enums.json` + `expected-errors.json`

- [ ] **Step 1: `enum-array` input** — a `field.enum` with `isArray`:
```json
{ "field.enum": { "name": "tags", "isArray": true, "@values": ["RED", "GREEN", "BLUE"] } }
```
Wrap in the same `metadata.root`/`object.entity` envelope as Task 1.1 (give the entity an `id` + `identity.primary`). Write the matching canonical `expected.json` (note `isArray` is a structural key ordered before `@`-attrs).

- [ ] **Step 2: `error-enum-missing-values`** — a `field.enum` with NO `@values`:

`input/meta.enums.json`: an `Order` with `{ "field.enum": { "name": "status" } }` (+ id + primary).
`expected-errors.json`:
```json
[ { "code": "ERR_MISSING_REQUIRED_ATTR" } ]
```

- [ ] **Step 3: Run both — confirm FAIL** (unknown subtype for now)

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "enum"`
Expected: FAIL.

- [ ] **Step 4: Commit**

```bash
git add fixtures/conformance/enum-array fixtures/conformance/error-enum-missing-values
git commit -m "test(conformance): add enum-array + missing-values fixtures (red)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — TypeScript metamodel

Makes the Phase 1 happy-path + missing-values fixtures pass. Package: `server/typescript/packages/metadata`.

### Task 2.1: Add the `enum` subtype + `@values` constants

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/field/field-constants.ts`

- [ ] **Step 1: Add the subtype constant** after `FIELD_SUBTYPE_CURRENCY` (line 23):
```typescript
export const FIELD_SUBTYPE_ENUM = "enum";
```
Add `FIELD_SUBTYPE_ENUM,` to the `FIELD_SUBTYPES` array (after `FIELD_SUBTYPE_CURRENCY`, ~line 41).

- [ ] **Step 2: Add the attr constant** after the currency attrs (~line 103):
```typescript
/** Member symbols of an enum-subtype field. Required, string array. */
export const FIELD_ATTR_VALUES = "values";
```

- [ ] **Step 3: Typecheck**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/metadata' typecheck`
Expected: PASS.

- [ ] **Step 4: Commit** (`feat(metadata): enum subtype + @values constants`, with trailer).

### Task 2.2: Declare the `@values` attr schema

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/field/field-schema.ts`

- [ ] **Step 1: Add the attr schema** after `currencyFieldAttr` (~line 135), mirroring `identityFieldsAttr` (string array, required):
```typescript
export const enumFieldAttr: AttrSchema = {
  name: FIELD_ATTR_VALUES,
  valueType: ATTR_SUBTYPE_STRINGARRAY,
  required: true,
  description:
    "Member symbols of an enum-subtype field. Declaration order is significant; each is a legal identifier and its own stored string.",
};
```

- [ ] **Step 2: Add `FIELD_ATTR_VALUES`** to the import from `./field-constants.js` (~line 12) and ensure `ATTR_SUBTYPE_STRINGARRAY` is imported (as `identityFieldsAttr` uses it).

- [ ] **Step 3: Typecheck** (as 2.1 Step 3). Commit.

### Task 2.3: Register `@values` on the `enum` subtype

**Files:**
- Modify: `server/typescript/packages/metadata/src/core-types.ts`

- [ ] **Step 1: Extend the field-subtype registration** (~lines 200-203) to attach `enumFieldAttr` for the enum subtype:
```typescript
const fieldAttrs =
  subType === FIELD_SUBTYPE_CURRENCY
    ? [...commonFieldAttrs, { ...currencyFieldAttr }]
    : subType === FIELD_SUBTYPE_ENUM
      ? [...commonFieldAttrs, { ...enumFieldAttr }]
      : [...commonFieldAttrs];
```

- [ ] **Step 2: Add imports** — `FIELD_SUBTYPE_ENUM` (alongside `FIELD_SUBTYPE_CURRENCY`, ~line 65) and `enumFieldAttr` (alongside `currencyFieldAttr`, ~line 37).

- [ ] **Step 3: Typecheck.** Commit.

### Task 2.4: Map the `enum` subtype to a data type

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/field/meta-field.ts`

- [ ] **Step 1: Add to `FIELD_DATA_TYPE`** (after the `FIELD_SUBTYPE_CURRENCY` entry, ~line 59):
```typescript
[FIELD_SUBTYPE_ENUM]: DATA_TYPE_STRING,
```
Add `FIELD_SUBTYPE_ENUM` to the field-constants import (~lines 21-27).

- [ ] **Step 2: Run the Phase 1 happy-path + missing-values fixtures**

Run: `cd server/typescript && bun test packages/metadata/test/conformance.test.ts -t "enum"`
Expected: PASS for `enum-inline`, `enum-abstract-extends`, `enum-array`, `error-enum-missing-values`.

- [ ] **Step 3: Commit** (`feat(metadata): map enum subtype to DATA_TYPE_STRING; conformance green`).

### Task 2.5: Unit test — abstract `field.enum` + extends inherits `@values`

**Files:**
- Test: `server/typescript/packages/metadata/test/field-enum.test.ts` (create)

- [ ] **Step 1: Write the test** — load a doc with an abstract `field.enum Status` and a concrete field `extends: "Status"`; assert the concrete field's effective `@values` equals the abstract's. Use the package's existing load helper (copy the import/usage pattern from `test/loader/*.test.ts`).

- [ ] **Step 2: Run — expect PASS** (inheritance already works via effective-children; this locks it).

Run: `cd server/typescript && bun test packages/metadata/test/field-enum.test.ts`

- [ ] **Step 3: Commit.**

### Task 2.6 (optional): `field.effective-attr` conformance capability

Only if Task 1.2's `script.json` was kept.

**Files:**
- Modify: `fixtures/conformance/CAPABILITIES.json` (add `"field.effective-attr"`)
- Modify: the TS conformance adapter that dispatches `invoke` operations (find via `bun test` trace from `packages/metadata/test/conformance.test.ts`).

- [ ] **Step 1:** Add the capability name to `CAPABILITIES.json`.
- [ ] **Step 2:** Implement the `field.effective-attr` op in the TS adapter (return the field's effective attr value by name).
- [ ] **Step 3:** Run `enum-abstract-extends` — expect PASS. Commit.

---

## Phase 3 — TypeScript codegen

Package: `server/typescript/packages/codegen-ts`.

### Task 3.1: Zod `z.enum([...])` emission

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/zod-validators.ts`
- Test: `server/typescript/packages/codegen-ts/test/zod-validators.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — a `field.enum status @values:["DRAFT","PUBLISHED"]` renders `z.enum(["DRAFT", "PUBLISHED"])`. Follow the existing test setup in that file (build a MetaField, call the zod renderer).

- [ ] **Step 2: Run — FAIL** (emits `z.string()`).

Run: `cd server/typescript && bun test packages/codegen-ts/test/zod-validators.test.ts -t "enum"`

- [ ] **Step 3: Implement** — in `zodFieldExpr` (~lines 80-104), add before `default`:
```typescript
case FIELD_SUBTYPE_ENUM: {
  const values = field.ownAttr(FIELD_ATTR_VALUES);
  base = Array.isArray(values)
    ? `z.enum([${values.map((v) => JSON.stringify(String(v))).join(", ")}])`
    : "z.string()";
  break;
}
```
Add `FIELD_SUBTYPE_ENUM, FIELD_ATTR_VALUES` to the metadata import (~lines 9-18).

- [ ] **Step 4: Run — PASS.** Commit.

### Task 3.2: Named enum type alias in the entity file

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/inferred-types.ts`
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-file.ts`
- Test: `server/typescript/packages/codegen-ts/test/entity-file.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — an entity with a `field.enum status @values:["DRAFT","PUBLISHED"]` emits `export type OrderStatus = "DRAFT" | "PUBLISHED";` (inline naming `<Entity><FieldPascal>`); and an entity whose field `extends` an abstract `Status` emits `export type Status = ...` once.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `renderEnumTypeAliases(entity)` in `inferred-types.ts`:
```typescript
export function renderEnumTypeAliases(entity: MetaObject): Code | null {
  const aliases: string[] = [];
  for (const field of entity.fields()) {
    if (field.subType !== FIELD_SUBTYPE_ENUM) continue;
    const values = field.ownAttr(FIELD_ATTR_VALUES) ?? field.attr(FIELD_ATTR_VALUES);
    if (!Array.isArray(values)) continue;
    const typeName = enumTypeName(entity, field); // abstract super name, else <Entity><FieldPascal>
    const union = values.map((v) => JSON.stringify(String(v))).join(" | ");
    aliases.push(`export type ${typeName} = ${union};`);
  }
  return aliases.length ? code`${aliases.join("\n")}` : null;
}
```
Implement `enumTypeName`: if the field resolves a super (`field.resolveSuper()`), use the super field's PascalName; else `${entity.name}${pascal(field.name)}`. Add it to the `sections` array in `entity-file.ts` *before* the Zod section, guarded for null.

- [ ] **Step 4: Run — PASS.** Commit.

### Task 3.3: DB `CHECK` constraint for enum columns

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/column-mapper.ts`
- Test: `server/typescript/packages/codegen-ts/test/column-mapper.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — for both `sqlite` and `postgres` dialects, a `field.enum status @values:["DRAFT","PUBLISHED"]` maps to a `text` column carrying a CHECK constraint of `status IN ('DRAFT', 'PUBLISHED')`. Assert via the `ColumnSpec` shape the test already inspects.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement:**
  - Add `FIELD_SUBTYPE_ENUM, FIELD_ATTR_VALUES` to imports.
  - In BOTH dialect switches add `case FIELD_SUBTYPE_ENUM: fnName = "text"; break;` (before `default`).
  - Add `checkConstraint?: string;` to `ColumnSpec`.
  - After modifiers are built, for enum fields set:
    ```typescript
    const values = field.ownAttr(FIELD_ATTR_VALUES) ?? field.attr(FIELD_ATTR_VALUES);
    if (field.subType === FIELD_SUBTYPE_ENUM && Array.isArray(values)) {
      const list = values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(", ");
      spec.checkConstraint = `${spec.dbName} IN (${list})`;
    }
    ```
  - In the Drizzle schema template that consumes `ColumnSpec` (find the consumer of `checkConstraint`), emit a table-level `check()` using drizzle's `sql` tag. (Add a sibling test if the template is separately tested.)

- [ ] **Step 4: Run — PASS.** Commit.

### Task 3.4: Projection read-schema support

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/field-meta.ts` (`zodTypeFor`, ~lines 78-102)
- Test: extend the relevant field-meta test.

- [ ] **Step 1: Failing test** — `zodTypeFor` on an enum field returns the `z.enum([...])` form (so projections over enum fields stay typed).
- [ ] **Step 2: Run — FAIL. Step 3: add the `FIELD_SUBTYPE_ENUM` case mirroring Task 3.1. Step 4: PASS. Commit.**

### Task 3.5: Full TS suite green

- [ ] **Step 1:** Run `cd server/typescript && bun test`. Expected: all pass (2124+ plus new).
- [ ] **Step 2:** Run `bun run --filter '*' typecheck` from repo root. Expected: clean.
- [ ] **Step 3:** Commit any fixups.

---

## Phase 4 — C# metamodel + codegen

Project root: `server/csharp`. Mirror `currency`/`object` precedents named below.

### Task 4.1: Subtype + `@values` constant + schema + registration

**Files:**
- Modify: `server/csharp/MetaObjects/Core/Field/FieldConstants.cs`
- Modify: `server/csharp/MetaObjects/Core/Field/FieldSchema.cs`
- Modify: `server/csharp/MetaObjects/CoreTypes.cs`

- [ ] **Step 1:** In `FieldConstants.cs` add after `FIELD_SUBTYPE_CURRENCY` (line 35):
```csharp
public const string FIELD_SUBTYPE_ENUM = "enum";
```
add `FIELD_SUBTYPE_ENUM,` to the `FIELD_SUBTYPES` array; and add:
```csharp
public const string FIELD_ATTR_VALUES = "values";
```

- [ ] **Step 2:** In `FieldSchema.cs` after `CurrencyFieldAttr` add:
```csharp
public static readonly AttrSchema EnumValuesAttr = new AttrSchema(
    Name: FieldConstants.FIELD_ATTR_VALUES,
    ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY,
    Required: true,
    Description: "Member symbols of an enum-subtype field; declaration order significant.");
```

- [ ] **Step 3:** In `CoreTypes.cs` field-subtype loop (~lines 232-235) add the enum branch:
```csharp
List<AttrSchema> fieldAttrs =
    subType == FIELD_SUBTYPE_CURRENCY
        ? [.. FieldSchema.CommonFieldAttrs, FieldSchema.CurrencyFieldAttr]
        : subType == FIELD_SUBTYPE_ENUM
            ? [.. FieldSchema.CommonFieldAttrs, FieldSchema.EnumValuesAttr]
            : FieldSchema.CommonFieldAttrs.ToList();
```

- [ ] **Step 4:** `cd server/csharp && dotnet build`. Expected: builds.
- [ ] **Step 5:** Commit.

### Task 4.2: C# conformance — enum fixtures pass

**Files:** (no source change expected; serializer is generic)

- [ ] **Step 1:** Run the dotnet conformance runner: `cd server/csharp && dotnet test --filter Conformance`. Expected: the new `enum-*` happy-path + `error-enum-missing-values` fixtures pass (serializer round-trips the stringarray attr automatically).
- [ ] **Step 2:** If any fail on canonical formatting, reconcile `expected.json` (the TS run in Phase 2 is the source of truth — they share the file). Commit any fixture fix.

### Task 4.3: `EnumValues` accessor on `MetaField`

**Files:**
- Modify: `server/csharp/MetaObjects/Meta/MetaField.cs`
- Test: add to the C# metadata test project.

- [ ] **Step 1: Failing test** — a loaded `field.enum` exposes `EnumValues` == the members.
- [ ] **Step 2: Implement** after the `Unique` property (~line 100):
```csharp
/// <summary>Member symbols of an enum-subtype field (the @values attr).</summary>
public IReadOnlyList<string>? EnumValues =>
    OwnAttr(FieldConstants.FIELD_ATTR_VALUES) is IReadOnlyList<string> a ? a : null;
```
For the reusable case also expose an effective lookup if the codegen needs inherited values (mirror how other effective attrs are read).
- [ ] **Step 3: PASS. Commit.**

### Task 4.4: Emit C# `enum` type + property

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/CSharpNaming.cs`
- Modify: `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs`
- Test: `server/csharp/MetaObjects.Codegen.Tests` entity-generator test.

- [ ] **Step 1: Failing test** — an entity with `field.enum status @values:["DRAFT","PUBLISHED"]` emits a nested `public enum Status { DRAFT, PUBLISHED }` and a property `public Status Status { get; set; }`. (Members verbatim — no PascalCase re-casing — to keep symbol == stored value.)

- [ ] **Step 2:** In `CSharpNaming.cs` `ScalarType` dict add after currency (~line 25): `[FIELD_SUBTYPE_ENUM] = "string"` (used only as a fallback; enum fields get the nested type, see Step 3).

- [ ] **Step 3:** In `EntityGenerator.cs` field loop (~lines 78-95): when `field.SubType == FIELD_SUBTYPE_ENUM`, emit a nested enum and a property typed by it. Helper:
```csharp
private static string EmitNestedEnum(MetaField f)
{
    var name = CSharpNaming.Pascal(f.Name);
    var members = string.Join(", ", f.EnumValues ?? []);
    return $"    public enum {name} {{ {members} }}";
}
```
The property type is the nested enum name; default the type-name to the abstract super's name when the field `extends` one (mirror Task 3.2's naming rule).

- [ ] **Step 4: PASS. Commit.**

### Task 4.5: EF Core `HasConversion<string>()`

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs`
- Test: DbContext generator test.

- [ ] **Step 1: Failing test** — `OnModelCreating` contains `modelBuilder.Entity<Order>().Property(x => x.Status).HasConversion<string>();` for an enum field.
- [ ] **Step 2: Implement** a loop after owned-type config (~line 36) emitting one `HasConversion<string>()` line per enum field on each non-projection entity.
- [ ] **Step 3: PASS. Commit.**

### Task 4.6: Postgres `CHECK` DDL

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Schema/PostgresSchema.cs`
- Test: Postgres schema/DDL test.

- [ ] **Step 1: Failing test** — `CreateTable` for an enum field emits `status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED'))` (mirror existing FK/unique constraint assertions).
- [ ] **Step 2:** In `PgType` switch add `FIELD_SUBTYPE_ENUM => "text"` (after currency, ~line 47). In `CreateTable` (after columns, before PK, ~line 82) append a CHECK line per enum field:
```csharp
foreach (var f in entity.Fields().Where(f => f.SubType == FIELD_SUBTYPE_ENUM && f.EnumValues is { Count: > 0 }))
    lines.Add($"  CHECK ({CSharpNaming.Column(f)} IN ({string.Join(", ", f.EnumValues.Select(v => $"'{v}'"))}))");
```
- [ ] **Step 3: PASS. Commit.**

### Task 4.7: C# validation unit tests (identifier-safety + duplicates)

**Files:**
- Modify: wherever field-attr value validation runs in `MetaObjects` (the pass emitting `ERR_BAD_ATTR_VALUE`).
- Test: C# metadata test project.

- [ ] **Step 1: Failing tests** — loading `field.enum` with `@values:["in-progress"]` yields `ERR_BAD_ATTR_VALUE`; `@values:["A","A"]` yields `ERR_BAD_ATTR_VALUE`.
- [ ] **Step 2: Implement** an enum-`@values` content check (regex `^[A-Za-z_][A-Za-z0-9_]*$` per member; reject duplicates) in the validation pass, emitting `ERR_BAD_ATTR_VALUE`.
- [ ] **Step 3: PASS. Commit.**

### Task 4.8: C# suite green

- [ ] Run `cd server/csharp && dotnet test`. Expected: all pass. Commit fixups.

---

## Phase 5 — TypeScript validation (identifier-safety + duplicates)

Done after codegen so the codegen tests above can assume valid input. Package: `metadata`.

### Task 5.1: Enum `@values` content validation

**Files:**
- Modify: the TS validation pass that emits `ERR_BAD_ATTR_VALUE` (the `allowedValues` validator — locate via `bun test` trace from a fixture that emits `ERR_BAD_ATTR_VALUE`, e.g. `attr-schema-validate`).
- Test: `server/typescript/packages/metadata/test/field-enum.test.ts` (extend Task 2.5's file).

- [ ] **Step 1: Failing tests** — `@values:["in-progress"]` → `ERR_BAD_ATTR_VALUE`; `@values:["A","A"]` → `ERR_BAD_ATTR_VALUE`; `@values:["A","B"]` → no error.
- [ ] **Step 2: Implement** a focused validator: for an enum field's `@values`, each member must match `^[A-Za-z_][A-Za-z0-9_]*$` and be unique; push `ERR_BAD_ATTR_VALUE` otherwise. Reuse the existing error-construction helper in that pass. Add the regex as a named constant in `field-constants.ts` (`ENUM_MEMBER_PATTERN`).
- [ ] **Step 3: PASS.** Run full `cd server/typescript && bun test`. Commit.

---

## Phase 6 — Java metamodel recognition

Project: `server/java/metadata`. Loader-level only (no codegen tier yet).

### Task 6.1: `EnumField` class + registration

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/field/EnumField.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/field/FieldTypesMetaDataProvider.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/field/EnumFieldTest.java` (create)

- [ ] **Step 1: Failing test** — parse a canonical JSON doc with `field.enum @values:[...]`; assert the loader accepts it and `CanonicalJsonSerializer` round-trips `@values`. Mirror `CanonicalJsonSerializerTest`.

- [ ] **Step 2: Create `EnumField`** mirroring `StringField`:
```java
public final class EnumField extends PrimitiveField<String> {
    public static final String SUBTYPE_ENUM = "enum";
    public EnumField(String name) { super(SUBTYPE_ENUM, name, DataTypes.STRING); }
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(EnumField.class, def -> {
            def.type(TYPE_FIELD).subType(SUBTYPE_ENUM)
               .description("Enum field: value constrained to @values member set.")
               .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);
            def.requiredAttributeWithConstraints("values")
               .ofType(StringArrayAttribute.SUBTYPE_STRINGARRAY);
        });
    }
}
```
(Confirm the exact base class + `PrimitiveField<String>` constructor signature against `StringField`/`LongField`.)

- [ ] **Step 3: Register** — add `EnumField.registerTypes(registry);` to `FieldTypesMetaDataProvider.registerTypes()` (after `ClassField`, ~line 63).

- [ ] **Step 4: Run — PASS.**

Run: `cd server/java && ./gradlew :metadata:test --tests "*EnumFieldTest*"`

- [ ] **Step 5: Commit.**

---

## Phase 7 — Python metamodel recognition

Project: `server/python`. Loader-level only.

### Task 7.1: Subtype constant + registration

**Files:**
- Modify: `server/python/src/metaobjects/meta/core/field/field_constants.py`
- Modify: `server/python/src/metaobjects/core_types.py`
- Test: `server/python/tests/test_field_enum.py` (create)

- [ ] **Step 1: Failing test** — load a doc with `field.enum @values:[...]`; assert it loads and the canonical serializer round-trips `@values`. Mirror an existing loader test.

- [ ] **Step 2:** In `field_constants.py` add `FIELD_SUBTYPE_ENUM = "enum"` and append it to `FIELD_SUBTYPES`.

- [ ] **Step 3:** In `core_types.py`, after the generic field-subtype registration (~line 130), add a dedicated `TypeDefinition` for `field.enum` carrying the `@values` attr:
```python
core_provider.add(
    TypeDefinition(
        type=TYPE_FIELD,
        sub_type=fc.FIELD_SUBTYPE_ENUM,
        factory=MetaField,
        attrs=[AttrSchema(name="values", value_type=ATTR_SUBTYPE_STRINGARRAY, required=True)],
        child_rules=[ChildRule(TYPE_ATTR, "*"), ChildRule(TYPE_ORIGIN, "*"), ChildRule(TYPE_VIEW, "*")],
    )
)
```
(Ensure the generic `_register_subtypes` call does not also register `enum`, or that this dedicated def wins — check `_register_subtypes` and exclude `FIELD_SUBTYPE_ENUM` from its set if needed.)

- [ ] **Step 4: Run — PASS.**

Run: `cd server/python && pytest tests/test_field_enum.py`

- [ ] **Step 5: Commit.**

### Task 7.2: Python conformance auto-run

- [ ] **Step 1:** Run `cd server/python && pytest tests/conformance`. Expected: the `enum-*` happy-path + `error-enum-missing-values` fixtures are auto-discovered and pass.
- [ ] **Step 2:** If `enum-abstract-extends`'s `script.json` uses a capability Python doesn't implement, add it to `server/python/tests/conformance/conformance-expected-failures.json` as a documented known-gap (only if truly unimplemented). Commit.

---

## Phase 8 — Full cross-language verification

- [ ] **Step 1: TS** — `cd server/typescript && bun test` + `bun run --filter '*' typecheck` (repo root). All green.
- [ ] **Step 2: C#** — `cd server/csharp && dotnet test`. All green.
- [ ] **Step 3: Python** — `cd server/python && pytest`. All green.
- [ ] **Step 4: Java** — `cd server/java && ./gradlew :metadata:test`. All green.
- [ ] **Step 5: Update status docs** — note `field.enum` shipped in `spec/roadmap.md` and (if it tracks per-feature status) `CLAUDE.md`'s status section. Mark the design spec `Status: Implemented`.
- [ ] **Step 6: Final commit** (`feat: field.enum datatype across TS/C#/Java/Python + conformance`).

---

## Self-review notes

- **Spec coverage:** D1 subtype (Tasks 2.1/4.1/6.1/7.1), D2 field-subtype not validator (whole structure), D3 `@values` (2.2/4.1/6.1/7.1), D4 string-backed v1 (data-type maps; int-backed untouched), D5 `varchar`+`CHECK` (3.3/4.6), D6 abstract+extends reuse (1.2/2.5), D7 identifier/quoting guard (5.1/4.7; YAML coercion guard deferred to ADR-0006 per spec). Codegen table (3.1/3.2/3.3/4.4/4.5/4.6). Cross-language contract (Phase 1 fixtures). Fixtures (Phase 1). Deferred items untouched. ✓
- **Naming consistency:** `FIELD_SUBTYPE_ENUM` / `FIELD_ATTR_VALUES` / `enumFieldAttr` / `EnumValuesAttr` / `EnumValues` / `SUBTYPE_ENUM` used consistently per language convention.
- **Deviation from spec:** the `enum-reject-non-identifier-member` and `enum-reject-duplicate-member` cases are TS+C# unit tests in v1 (Tasks 5.1/4.7), not shared conformance fixtures, because Java/Python don't implement those custom checks yet — avoids known-gap bookkeeping. They graduate to shared error fixtures when those ports add the checks. Rationale recorded in the Scope note.
