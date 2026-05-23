# C# `@storage` First-Class Support Plan (Plan C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Prerequisite:** Plan A (`2026-05-23-csharp-constants-colocation.md`) must land first — this plan adds files under `Core/Field/` which Plan A creates. It is independent of Plan B (schema namespacing), so they can execute in either order after Plan A.

**Goal:** Carry the TS field-object-storage feature (Plan @storage, merged 2026-05-23) to C#. The `@storage` attribute on `field.object` (with `@objectRef`) is currently opaque-passthrough on C# — fixtures pass round-trip but the C# loader doesn't declare the attr, doesn't enforce the `flattened`/`jsonb`/`subdocument` enum, and doesn't run the two cross-attribute validators (`ERR_STORAGE_WITHOUT_OBJECT_REF`, `ERR_STORAGE_FLATTENED_ARRAY`). This plan brings C# to parity.

**Architecture:** Three concerns, all additive:
1. Constants: `FIELD_ATTR_STORAGE`, `STORAGE_FLATTENED`, `STORAGE_JSONB`, `STORAGE_SUBDOCUMENT` go into `Core/Field/FieldConstants.cs`. A `STORAGE_VALUES` list pins the enum.
2. Schema: `@storage` entry on `commonFieldAttrs` in `Core/Field/FieldSchema.cs`, with `allowedValues: STORAGE_VALUES`.
3. Cross-attribute validation: a new `ValidateFieldObjectStorage` method runs at load time, walking every `field.object` and emitting `ERR_STORAGE_WITHOUT_OBJECT_REF` / `ERR_STORAGE_FLATTENED_ARRAY` for invalid combinations.

**Tech Stack:** C# 12 / .NET 8, xUnit-style tests, `MetaObjects.Conformance.Tests` is the regression guardrail.

---

## File Structure

**Modify (created by Plan A):**
- `server/csharp/MetaObjects/Core/Field/FieldConstants.cs` — add `ATTR_STORAGE` + `STORAGE_*` + `STORAGE_VALUES`
- `server/csharp/MetaObjects/Core/Field/FieldSchema.cs` — add `@storage` entry to `CommonFieldAttrs`
- `server/csharp/MetaObjects/Loader/<wherever validation passes live>` — add `ValidateFieldObjectStorage`
- `server/csharp/MetaObjects/Errors.cs` — register two new error codes
- `fixtures/conformance/ERROR-CODES.json` — register the new codes if not already there (they should be — TS added them on 2026-05-22)

**Create:**
- `server/csharp/MetaObjects.Tests/Loader/FieldObjectStorageValidationTests.cs` — 4 tests mirroring the TS `storage-validation.test.ts`

---

## Task 1: Add the `@storage` constants

**Files:**
- Modify: `server/csharp/MetaObjects/Core/Field/FieldConstants.cs`

- [ ] **Step 1: Append the storage constants**

Open `server/csharp/MetaObjects/Core/Field/FieldConstants.cs` (created by Plan A). Find the field-attr block (where `ATTR_OBJECT_REF` lives). Append directly after `ATTR_OBJECT_REF`:

```csharp
    /// <summary>
    /// Storage strategy for an object-typed field. Meaningful only when @objectRef is set.
    /// Cross-language metamodel attr — every port must accept and round-trip it.
    /// </summary>
    public const string ATTR_STORAGE = "storage";

    /// <summary>
    /// @storage "flattened" — nested object's columns expand into the parent table,
    /// each prefixed by the parent field's DB name (EF OwnsOne pattern). Requires
    /// the parent field.object to have isArray=false; arrays-of-values must use jsonb.
    /// </summary>
    public const string STORAGE_FLATTENED = "flattened";

    /// <summary>
    /// @storage "jsonb" — the nested value (or array of values when isArray=true) lives
    /// in a single jsonb column. The structure is typed by metadata; storage is opaque.
    /// </summary>
    public const string STORAGE_JSONB = "jsonb";

    /// <summary>
    /// @storage "subdocument" — document-store-native nested document. No Postgres
    /// column is emitted for this; codegen targets like Mongo render it inline.
    /// </summary>
    public const string STORAGE_SUBDOCUMENT = "subdocument";

    public static readonly IReadOnlyList<string> STORAGE_VALUES = new[]
    {
        STORAGE_FLATTENED, STORAGE_JSONB, STORAGE_SUBDOCUMENT,
    };
```

- [ ] **Step 2: Build**

```bash
cd server/csharp && dotnet build
```

Expected: build clean.

- [ ] **Step 3: Commit**

```bash
git add server/csharp/MetaObjects/Core/Field/FieldConstants.cs
git commit -m "feat(csharp/metadata): add FIELD.ATTR_STORAGE + STORAGE_* value constants"
```

---

## Task 2: Add `@storage` to the field attr-schema

**Files:**
- Modify: `server/csharp/MetaObjects/Core/Field/FieldSchema.cs`

- [ ] **Step 1: Add the schema entry**

Open `server/csharp/MetaObjects/Core/Field/FieldSchema.cs` (created by Plan A). Find the `CommonFieldAttrs` collection. The `@objectRef` entry is the partner — `@storage` sits directly after it. Add (adapt to the exact `AttrSchema` constructor signature used in the project):

```csharp
new AttrSchema(
    name: FieldConstants.ATTR_STORAGE,
    valueType: AttrConstants.SUBTYPE_STRING,
    required: false,
    allowedValues: FieldConstants.STORAGE_VALUES.ToList(),
    description:
        "Storage strategy for an object-typed field (set with @objectRef). " +
        "\"flattened\" expands the nested value into prefixed columns on the parent " +
        "table. \"jsonb\" stores the structured value in a single jsonb column " +
        "(supports isArray=true for arrays of values). \"subdocument\" is a hint for " +
        "document-store codegen targets and emits no Postgres column.")
```

The schema framework should validate the enum via `allowedValues` automatically (just as TS does via `STORAGE_VALUES`).

- [ ] **Step 2: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: build clean, 168 / 0 fail. The 4 `field-object-storage-*` fixtures still pass — they now exercise declared-attr validation, not opaque passthrough.

- [ ] **Step 3: Commit**

```bash
git add server/csharp/MetaObjects/Core/Field/FieldSchema.cs
git commit -m "feat(csharp/metadata): declare @storage attr-schema for object-typed fields (matches TS)"
```

---

## Task 3: Register the two new error codes in `Errors.cs`

**Files:**
- Modify: `server/csharp/MetaObjects/Errors.cs`
- Modify: `fixtures/conformance/ERROR-CODES.json` (if not already there)

- [ ] **Step 1: Check whether the codes are already in ERROR-CODES.json**

```bash
grep "ERR_STORAGE" fixtures/conformance/ERROR-CODES.json
```

If the codes are present (added by TS on 2026-05-22), proceed to Step 2 without modifying the JSON. If they're missing, add them per the TS plan's spec:

```json
"ERR_STORAGE_FLATTENED_ARRAY": "@storage \"flattened\" cannot be combined with isArray=true.",
"ERR_STORAGE_WITHOUT_OBJECT_REF": "@storage was set on a field that has no @objectRef."
```

- [ ] **Step 2: Register in C# `Errors.cs`**

Open `server/csharp/MetaObjects/Errors.cs`. Find the existing `ERR_*` constants or enum. Add:

```csharp
    public const string ERR_STORAGE_WITHOUT_OBJECT_REF = "ERR_STORAGE_WITHOUT_OBJECT_REF";
    public const string ERR_STORAGE_FLATTENED_ARRAY    = "ERR_STORAGE_FLATTENED_ARRAY";
```

(Or extend the relevant enum / record per the C# project's pattern — read the file first to match.)

- [ ] **Step 3: Build + commit**

```bash
cd server/csharp && dotnet build
git add server/csharp/MetaObjects/Errors.cs fixtures/conformance/ERROR-CODES.json
git commit -m "feat(csharp/metadata): register ERR_STORAGE_WITHOUT_OBJECT_REF + ERR_STORAGE_FLATTENED_ARRAY"
```

---

## Task 4: Add the cross-attribute validator `ValidateFieldObjectStorage`

**Files:**
- Modify: wherever C# validation passes live (likely `server/csharp/MetaObjects/Loader/<something>.cs` — search for existing validators like a port of `validateOriginPaths` or `validateDataGridSortFields`)
- Test (new): `server/csharp/MetaObjects.Tests/Loader/FieldObjectStorageValidationTests.cs`

- [ ] **Step 1: Locate the existing cross-attribute validation pattern**

```bash
cd server/csharp && grep -rln "ValidateOriginPaths\|ValidateDataGrid\|cross.attribute" --include="*.cs" | head
```

Find where the C# port of `validateOriginPaths` (and friends) lives. It might be in `Loader/MetaDataLoader.cs` or a separate `ValidationPasses.cs`. Read it to find:
- The function signature pattern (likely `static List<ParseError> ValidateXxx(MetaRoot root)`)
- Where it's invoked in `MetaDataLoader.Load`
- The `ParseError` constructor + how `code` is attached

- [ ] **Step 2: Write the failing tests**

Create `server/csharp/MetaObjects.Tests/Loader/FieldObjectStorageValidationTests.cs`:

```csharp
using Xunit;
using MetaObjects.Loader;
using MetaObjects;

namespace MetaObjects.Tests.Loader;

public class FieldObjectStorageValidationTests
{
    private static (bool ok, IReadOnlyList<string> codes) Load(string json)
    {
        var loader = new MetaDataLoader();
        var result = loader.Load(new[] { new InMemorySource(json) });
        return (result.Errors.Count == 0,
                result.Errors.Select(e => e.Code).ToList());
    }

    [Fact]
    public void Storage_without_objectRef_is_rejected()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              {
                "object.entity": {
                  "name": "Order",
                  "children": [
                    { "source.dbTable": { "@name": "orders" } },
                    { "field.object": { "name": "addr", "@storage": "flattened" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.False(ok);
        Assert.Contains("ERR_STORAGE_WITHOUT_OBJECT_REF", codes);
    }

    [Fact]
    public void Storage_flattened_with_isArray_true_is_rejected()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } }
              ]}},
              {
                "object.entity": {
                  "name": "Order",
                  "children": [
                    { "source.dbTable": { "@name": "orders" } },
                    { "field.object": { "name": "addrs", "isArray": true, "@objectRef": "Address", "@storage": "flattened" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.False(ok);
        Assert.Contains("ERR_STORAGE_FLATTENED_ARRAY", codes);
    }

    [Fact]
    public void Storage_flattened_with_objectRef_and_isArray_false_passes()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } }
              ]}},
              {
                "object.entity": {
                  "name": "Order",
                  "children": [
                    { "source.dbTable": { "@name": "orders" } },
                    { "field.object": { "name": "addr", "@objectRef": "Address", "@storage": "flattened" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.True(ok);
    }

    [Fact]
    public void Storage_jsonb_with_isArray_true_passes()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              { "object.value": { "name": "ContactInfo", "children": [
                { "field.string": { "name": "email" } }
              ]}},
              {
                "object.entity": {
                  "name": "Patient",
                  "children": [
                    { "source.dbTable": { "@name": "patients" } },
                    { "field.object": { "name": "contactInfos", "isArray": true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.True(ok);
    }
}
```

**IMPORTANT:** Before writing this verbatim, READ an existing test file under `server/csharp/MetaObjects.Tests/` to find:
- The exact `using` statements
- The `InMemorySource` constructor (may have a different name in C#)
- The `MetaDataLoader.Load` result shape — is it `Result.Errors` or `result.errors`? Adapt accordingly.
- The xUnit conventions used (e.g., `[Fact]` vs `[Theory]`, `Assert.Contains` vs `Assert.Single(codes.Where(c => c == "..."))`)

- [ ] **Step 3: Run tests to verify failure**

```bash
cd server/csharp && dotnet test MetaObjects.Tests
```

Expected: the 2 "should be rejected" tests fail — the validator doesn't exist yet, the loader accepts the invalid metadata silently.

- [ ] **Step 4: Implement the validator**

Add a new method in the validation-passes file:

```csharp
/// <summary>
/// Cross-attribute validation for @storage on field.object:
///   - @storage requires @objectRef on the same field.
///   - @storage "flattened" requires isArray=false (cannot flatten a variable-length array).
/// </summary>
public static IReadOnlyList<ParseError> ValidateFieldObjectStorage(MetaRoot root)
{
    var errors = new List<ParseError>();
    foreach (var obj in root.OwnChildren().Where(c => c.Type == BaseTypes.TYPE_OBJECT))
    {
        foreach (var field in obj.OwnChildren().Where(c => c.Type == BaseTypes.TYPE_FIELD))
        {
            var storage = field.OwnAttr(FieldConstants.ATTR_STORAGE) as string;
            if (string.IsNullOrEmpty(storage)) continue;

            var objectRef = field.OwnAttr(FieldConstants.ATTR_OBJECT_REF) as string;
            if (string.IsNullOrEmpty(objectRef))
            {
                errors.Add(new ParseError(
                    $"field \"{obj.Name}.{field.Name}\" sets @storage but has no @objectRef",
                    Errors.ERR_STORAGE_WITHOUT_OBJECT_REF));
            }

            if (storage == FieldConstants.STORAGE_FLATTENED && field.IsArray)
            {
                errors.Add(new ParseError(
                    $"field \"{obj.Name}.{field.Name}\" sets @storage \"flattened\" with isArray=true; " +
                    "flattened storage requires a single nested value",
                    Errors.ERR_STORAGE_FLATTENED_ARRAY));
            }
        }
    }
    return errors;
}
```

Then wire into `MetaDataLoader.Load` — find where existing validation passes are invoked and append a call to `ValidateFieldObjectStorage(root)`. Append the returned errors to the loader's accumulating error list.

- [ ] **Step 5: Run tests to verify pass**

```bash
cd server/csharp && dotnet test MetaObjects.Tests
```

Expected: all 4 tests pass.

- [ ] **Step 6: Run conformance to confirm no regression**

```bash
cd server/csharp && dotnet test MetaObjects.Conformance.Tests
```

Expected: 168 / 0 fail. The 4 field-object-storage fixtures still pass (they're all valid metadata; the new validator doesn't fire on them).

- [ ] **Step 7: Commit**

```bash
git add server/csharp/MetaObjects/Loader/*.cs server/csharp/MetaObjects.Tests/Loader/FieldObjectStorageValidationTests.cs
git commit -m "feat(csharp/metadata): validate @storage cross-attribute constraints"
```

---

## Self-Review

**1. Spec coverage**

The field-object-storage feature in TS has four metadata-side artifacts:
- `FIELD_ATTR_STORAGE` + `STORAGE_*` + `STORAGE_VALUES` ✓ Task 1
- `@storage` schema entry on `commonFieldAttrs` ✓ Task 2
- Two `ERR_*` codes ✓ Task 3
- `ValidateFieldObjectStorage` cross-attribute validator ✓ Task 4

C# does NOT need the migrate-ts pipeline changes (`buildExpectedSchema` flatten logic) because that pipeline doesn't exist in C# yet — it lands via the larger C# tool plan.

**2. Placeholder scan**

Two "read the file first" prompts (Task 4 Step 1 + Step 2) — necessary because the validation-pass location and `AttrSchema` constructor signature are not stable until Plan A finalizes their layout. The implementer reads the actual file when this plan runs.

**3. Scope check**

4 tasks. ~half a day total once Plan A is in place. Each task commits independently with conformance green.

**4. Dependency check**

REQUIRES Plan A. Independent of Plan B (different concern). Plan B and Plan C can execute in any order after Plan A.

---

## Done When

- `FieldConstants.cs` exports `ATTR_STORAGE`, `STORAGE_FLATTENED`, `STORAGE_JSONB`, `STORAGE_SUBDOCUMENT`, `STORAGE_VALUES`
- `FieldSchema.cs` declares the `@storage` attr in `CommonFieldAttrs` with `allowedValues = STORAGE_VALUES`
- `Errors.cs` declares `ERR_STORAGE_WITHOUT_OBJECT_REF` + `ERR_STORAGE_FLATTENED_ARRAY`
- `ValidateFieldObjectStorage` is wired into the loader's validation pipeline
- `FieldObjectStorageValidationTests.cs` has 4 passing tests (2 reject-invalid, 2 accept-valid)
- `dotnet test MetaObjects.Conformance.Tests` is 168 / 0 fail
- The 4 field-object-storage conformance fixtures exercise declared-attr + cross-attribute validation, not opaque passthrough
