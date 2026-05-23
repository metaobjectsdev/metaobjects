# C# Constants Colocation + Provider Registration Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the TS constants-colocation + provider-based-registration refactor across to C#, eliminating the `Constants.cs` (540 LOC) and `CoreAttrSchemas.cs` (405 LOC) god-files in favor of per-concern files (`Core/Object/`, `Core/Field/`, `Core/Identity/`, etc.) and replacing the central `RegisterCoreTypeDefs` with per-concern self-registering providers.

**Architecture:** Mirror the TS shape under `server/csharp/MetaObjects/`. Each concern lives in its own subdirectory holding `<Concern>Constants.cs`, `<Concern>Schema.cs`, and a `<Concern>Types.cs` (or merged-into-Schema) that exposes a `RegisterTypes(TypeRegistry)` method. The existing `IMetaDataTypeProvider` interface in `Provider.cs` stays — its contract is already correct per ADR-0004. The change is replacing the monolithic `CoreTypes.RegisterCoreTypeDefs` body with composition of per-concern register calls.

**Tech Stack:** C# 12 / .NET 8, xUnit-style tests via `dotnet test`, the conformance corpus at `fixtures/conformance/` is the load-bearing safety property (must stay 168 / 0 fail throughout).

---

## Cross-cutting invariants

- **Conformance is the safety rail.** After every concern's relocation: `cd server/csharp && dotnet test MetaObjects.Conformance.Tests` must pass at 168 / 0 fail. Any divergence means a missed attr or a name mismatch.
- **Naming preserved.** `SCREAMING_SNAKE` constants keep their exact identifier names (`FIELD_ATTR_OBJECT_REF` stays `FIELD_ATTR_OBJECT_REF`) and string values. The wire format does not change.
- **`using static MetaObjects.Constants;` patterns elsewhere break.** Callers that use `Constants.FIELD_ATTR_FOO` must be updated to use the per-concern static class. The barrel-style import preserved in TS via `index.ts` re-exports has no idiomatic C# equivalent; instead callers add `using MetaObjects.Core.Field;` per concern.
- **Provider interface unchanged.** `IMetaDataTypeProvider.RegisterTypes(TypeRegistry)` is the existing contract. We add ONE class per concern that implements (or has a static `RegisterTypes` method called by) the core provider.

---

## File structure

Target directory layout under `server/csharp/MetaObjects/`:

```
MetaObjects/
├── Core/
│   ├── Object/    { ObjectConstants.cs, ObjectSchema.cs, ObjectTypes.cs }
│   ├── Field/     { FieldConstants.cs, FieldSchema.cs, FieldTypes.cs }
│   ├── Attr/      { AttrConstants.cs, AttrSchema.cs, AttrTypes.cs }
│   ├── Validator/ { ValidatorConstants.cs, ValidatorSchema.cs, ValidatorTypes.cs }
│   ├── Identity/  { IdentityConstants.cs, IdentitySchema.cs, IdentityTypes.cs }
│   ├── Relationship/ { RelationshipConstants.cs, RelationshipSchema.cs, RelationshipTypes.cs }
│   └── Query/     { QueryConstants.cs }                       // 9 filter ops + sort order
├── Persistence/
│   ├── Source/    { SourceConstants.cs, SourceSchema.cs, SourceTypes.cs }
│   ├── Origin/    { OriginConstants.cs, OriginSchema.cs, OriginTypes.cs }
│   └── Db/        { DbConstants.cs, DbSchema.cs, DbTypes.cs }  // @dbColumn, @db.indexed
├── Presentation/
│   ├── View/      { ViewConstants.cs, ViewSchema.cs, ViewTypes.cs }
│   └── Layout/    { LayoutConstants.cs, LayoutSchema.cs, LayoutTypes.cs }
├── Shared/
│   ├── BaseTypes.cs     // TYPE_*, SUBTYPE_BASE, BASE_TYPES list
│   ├── StructuralKeys.cs // RESERVED_KEY_*, ATTR_PREFIX, PACKAGE_SEPARATOR
│   └── (existing util types stay here if they have no concern home)
├── Loader/        // unchanged
├── Meta/          // existing MetaData / Meta* classes; will gradually colocate but NOT in this plan
├── CoreTypesProvider.cs   // new, replaces CoreTypes.cs after migration
├── Provider.cs            // unchanged (interface)
└── (other files unchanged)
```

**Modify (relocations):**
- DELETE `Constants.cs` (after every constant has been relocated)
- DELETE `CoreAttrSchemas.cs` (after every schema entry relocated)
- REPLACE `CoreTypes.cs` with a thin `CoreTypesProvider.cs` that composes per-concern providers

**Touch externally:**
- Callers using `Constants.FIELD_ATTR_*` need `using MetaObjects.Core.Field;` (or similar). Same for `CoreAttrSchemas.ObjectAttrs` etc.

---

## Execution sequence

The 14 concerns get migrated one at a time, conformance kept green between each. Order matters because some concerns depend on shared bases:

1. `Shared/` foundations (BaseTypes, StructuralKeys) — pre-requisite for everything else
2. `Core/Attr/` — attr subtypes are referenced by every other concern's schemas
3. `Core/Query/` — filter operators + sort order, referenced by Field
4. `Core/Field/` (largest concern — touches field subtypes + audit attrs + currency)
5. `Core/Object/`
6. `Core/Validator/`
7. `Core/Identity/` (includes the `IDENTITY_REFERENCE_ATTR_*` family)
8. `Core/Relationship/`
9. `Persistence/Source/`
10. `Persistence/Origin/`
11. `Persistence/Db/` (`@dbColumn`, `@db.indexed`)
12. `Presentation/View/`
13. `Presentation/Layout/` (`LAYOUT_SUBTYPE_DATA_GRID` + the 5 dataGrid attrs)
14. Final cleanup: delete `Constants.cs` + `CoreAttrSchemas.cs` + replace `CoreTypes.cs`

Each task has the same TDD shape: relocate constants, relocate schema, relocate type-registration, build + run conformance. The plan templates that pattern as one numbered task per concern.

---

## Task 1: Shared foundations — `Shared/BaseTypes.cs` and `Shared/StructuralKeys.cs`

**Files:**
- Create: `server/csharp/MetaObjects/Shared/BaseTypes.cs`
- Create: `server/csharp/MetaObjects/Shared/StructuralKeys.cs`
- Modify: `server/csharp/MetaObjects/Constants.cs` (delete the relocated content, leave a temporary re-export shim if cross-referenced)

- [ ] **Step 1: Create BaseTypes.cs**

```csharp
namespace MetaObjects.Shared;

/// <summary>
/// Base type discriminators — the 11 registered base types (Java metaobjects-core vocabulary).
/// Colocated per ADR-0003. Wire-format identifiers; do not rename.
/// </summary>
public static class BaseTypes
{
    public const string TYPE_METADATA     = "metadata";
    public const string TYPE_OBJECT       = "object";
    public const string TYPE_FIELD        = "field";
    public const string TYPE_ATTR         = "attr";
    public const string TYPE_VALIDATOR    = "validator";
    public const string TYPE_VIEW         = "view";
    public const string TYPE_IDENTITY     = "identity";
    public const string TYPE_RELATIONSHIP = "relationship";
    public const string TYPE_LAYOUT       = "layout";
    public const string TYPE_SOURCE       = "source";
    public const string TYPE_ORIGIN       = "origin";

    /// <summary>The universal subtype name (every base type has a `.base` subtype).</summary>
    public const string SUBTYPE_BASE = "base";

    /// <summary>All registered base type names, in canonical order.</summary>
    public static readonly IReadOnlyList<string> ALL = new[]
    {
        TYPE_METADATA, TYPE_OBJECT, TYPE_FIELD, TYPE_ATTR, TYPE_VALIDATOR,
        TYPE_VIEW, TYPE_IDENTITY, TYPE_RELATIONSHIP, TYPE_LAYOUT, TYPE_SOURCE, TYPE_ORIGIN,
    };
}
```

- [ ] **Step 2: Create StructuralKeys.cs**

```csharp
namespace MetaObjects.Shared;

/// <summary>
/// Reserved structural body keys + the @ prefix + the :: package separator + the fused-key form separator.
/// Colocated per ADR-0003. Wire-format identifiers; do not rename.
/// </summary>
public static class StructuralKeys
{
    public const string KEY_NAME     = "name";
    public const string KEY_PACKAGE  = "package";
    public const string KEY_EXTENDS  = "extends";
    public const string KEY_ABSTRACT = "abstract";
    public const string KEY_OVERLAY  = "overlay";
    public const string KEY_IS_ARRAY = "isArray";
    public const string KEY_CHILDREN = "children";
    public const string KEY_VALUE    = "value";

    public const string ATTR_PREFIX           = "@";
    public const string PACKAGE_SEPARATOR     = "::";
    public const string TYPE_SUBTYPE_SEPARATOR = ".";
    public const string CHILD_RULE_WILDCARD    = "*";
    public const string PACKAGE_PARENT         = "..";

    public const string JSON_KEY_SCHEMA = "$schema";

    public static readonly IReadOnlySet<string> RESERVED_KEYS = new HashSet<string>
    {
        KEY_NAME, KEY_PACKAGE, KEY_EXTENDS, KEY_ABSTRACT, KEY_OVERLAY,
        KEY_IS_ARRAY, KEY_CHILDREN, KEY_VALUE,
    };
}
```

- [ ] **Step 3: Update `Constants.cs` to re-export from the new locations (transitional shim)**

To keep the build green during the per-concern migration, the old `Constants` class temporarily becomes a re-export shim. Replace the content of `Constants.cs` (just the BaseTypes + StructuralKeys sections) with redirects:

```csharp
namespace MetaObjects;

// Transitional shim — see ADR-0003 + plan 2026-05-23-csharp-constants-colocation.md.
// Each concern's constants will move out of here as the colocation migration progresses.
// At the end of the plan this file is deleted entirely.
public static class Constants
{
    public const string TYPE_METADATA     = Shared.BaseTypes.TYPE_METADATA;
    public const string TYPE_OBJECT       = Shared.BaseTypes.TYPE_OBJECT;
    // ... and so on for every constant relocated so far
    // Keep the un-relocated constants inline until their concern's task runs.
}
```

(In practice the static-class redirection in C# uses `public const string TYPE_X = Shared.BaseTypes.TYPE_X;` line by line. C# does not have re-export syntax — each constant needs its own pass-through line. This is tedious but mechanical.)

- [ ] **Step 4: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: build clean, 168 / 0 fail conformance.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects/Shared/BaseTypes.cs server/csharp/MetaObjects/Shared/StructuralKeys.cs server/csharp/MetaObjects/Constants.cs
git commit -m "refactor(csharp): colocate base types + structural keys into Shared/ (ADR-0003)"
```

---

## Task 2: `Core/Attr/` — attr subtypes

**Files:**
- Create: `server/csharp/MetaObjects/Core/Attr/AttrConstants.cs`
- Create: `server/csharp/MetaObjects/Core/Attr/AttrSchema.cs` (initially empty — attrs don't carry common attrs; this file is for symmetry + a future home)
- Modify: `server/csharp/MetaObjects/Constants.cs` (delete the ATTR_* section; add pass-through lines)
- Modify: `server/csharp/MetaObjects/CoreAttrSchemas.cs` (if it has anything attr-specific, relocate)

- [ ] **Step 1: Create AttrConstants.cs**

```csharp
namespace MetaObjects.Core.Attr;

/// <summary>
/// Attr concern constants — the 9 attr subtypes that determine how an attribute value is parsed
/// and stored. Wire-format identifiers; do not rename.
/// </summary>
public static class AttrConstants
{
    public const string SUBTYPE_STRING      = "string";
    public const string SUBTYPE_INT         = "int";
    public const string SUBTYPE_LONG        = "long";
    public const string SUBTYPE_DOUBLE      = "double";
    public const string SUBTYPE_BOOLEAN     = "boolean";
    public const string SUBTYPE_CLASS       = "class";
    public const string SUBTYPE_PROPERTIES  = "properties";
    public const string SUBTYPE_STRINGARRAY = "stringarray";
    public const string SUBTYPE_FILTER      = "filter";

    public static readonly IReadOnlyList<string> SUBTYPES = new[]
    {
        Shared.BaseTypes.SUBTYPE_BASE,
        SUBTYPE_STRING, SUBTYPE_INT, SUBTYPE_LONG, SUBTYPE_DOUBLE,
        SUBTYPE_BOOLEAN, SUBTYPE_CLASS, SUBTYPE_PROPERTIES, SUBTYPE_STRINGARRAY,
        SUBTYPE_FILTER,
    };
}
```

- [ ] **Step 2: Update Constants.cs ATTR_SUBTYPE_* lines to pass through**

Replace the inline string constants in the ATTR section of `Constants.cs` with pass-throughs:

```csharp
    // ATTR subtypes — relocated to MetaObjects.Core.Attr.AttrConstants. Pass-through.
    public const string ATTR_SUBTYPE_STRING      = Core.Attr.AttrConstants.SUBTYPE_STRING;
    public const string ATTR_SUBTYPE_INT         = Core.Attr.AttrConstants.SUBTYPE_INT;
    public const string ATTR_SUBTYPE_LONG        = Core.Attr.AttrConstants.SUBTYPE_LONG;
    public const string ATTR_SUBTYPE_DOUBLE      = Core.Attr.AttrConstants.SUBTYPE_DOUBLE;
    public const string ATTR_SUBTYPE_BOOLEAN     = Core.Attr.AttrConstants.SUBTYPE_BOOLEAN;
    public const string ATTR_SUBTYPE_CLASS       = Core.Attr.AttrConstants.SUBTYPE_CLASS;
    public const string ATTR_SUBTYPE_PROPERTIES  = Core.Attr.AttrConstants.SUBTYPE_PROPERTIES;
    public const string ATTR_SUBTYPE_STRINGARRAY = Core.Attr.AttrConstants.SUBTYPE_STRINGARRAY;
    public const string ATTR_SUBTYPE_FILTER      = Core.Attr.AttrConstants.SUBTYPE_FILTER;
```

The existing `ATTR_SUBTYPES` array in `Constants.cs` should also redirect — replace its contents with `Core.Attr.AttrConstants.SUBTYPES.ToList()` or similar.

- [ ] **Step 3: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: 168 / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add server/csharp/MetaObjects/Core/Attr/AttrConstants.cs server/csharp/MetaObjects/Constants.cs
git commit -m "refactor(csharp): colocate attr subtypes into Core/Attr/ (ADR-0003)"
```

---

## Task 3: `Core/Query/QueryConstants.cs` — filter operators + sort order

**Files:**
- Create: `server/csharp/MetaObjects/Core/Query/QueryConstants.cs`
- Modify: `server/csharp/MetaObjects/Constants.cs` (delete FILTER_OP_* + SORT_ORDER_* + OPS_BY_SUBTYPE; add pass-throughs)

- [ ] **Step 1: Create QueryConstants.cs**

```csharp
namespace MetaObjects.Core.Query;

/// <summary>
/// Cross-cutting query vocabulary — the 9 filter operators + sort-order values + the
/// per-field-subtype operator allowlist. Consumed by codegen-ts, runtime-ts, runtime-web.
/// Cross-language identifiers per CLAUDE.md.
/// </summary>
public static class QueryConstants
{
    public const string FILTER_OP_EQ     = "eq";
    public const string FILTER_OP_NE     = "ne";
    public const string FILTER_OP_GT     = "gt";
    public const string FILTER_OP_GTE    = "gte";
    public const string FILTER_OP_LT     = "lt";
    public const string FILTER_OP_LTE    = "lte";
    public const string FILTER_OP_IN     = "in";
    public const string FILTER_OP_LIKE   = "like";
    public const string FILTER_OP_IS_NULL = "isNull";

    public static readonly IReadOnlyList<string> FILTER_OPS = new[]
    {
        FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE,
        FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL,
    };

    public const string SORT_ORDER_ASC  = "asc";
    public const string SORT_ORDER_DESC = "desc";

    public static readonly IReadOnlyList<string> SORT_ORDER_VALUES = new[]
    {
        SORT_ORDER_ASC, SORT_ORDER_DESC,
    };

    public const string FILTER_COMPOSE_OR  = "or";
    public const string FILTER_COMPOSE_AND = "and";

    /// <summary>
    /// Per-field-subtype operator allowlist. Keys are FIELD_SUBTYPE_* values; values are the
    /// operators legal on that subtype.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> OPS_BY_SUBTYPE =
        new Dictionary<string, IReadOnlyList<string>>
        {
            ["string"]    = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_IN, FILTER_OP_LIKE, FILTER_OP_IS_NULL },
            ["int"]       = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["short"]     = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["byte"]      = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["long"]      = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["double"]    = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["float"]     = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["decimal"]   = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["boolean"]   = new[] { FILTER_OP_EQ, FILTER_OP_IS_NULL },
            ["date"]      = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["time"]      = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
            ["timestamp"] = new[] { FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE, FILTER_OP_IN, FILTER_OP_IS_NULL },
        };

    /// <summary>Returns the operators legal on a given field subtype, or empty if the subtype is unknown.</summary>
    public static IReadOnlyList<string> OpsForSubType(string subType) =>
        OPS_BY_SUBTYPE.TryGetValue(subType, out var ops) ? ops : Array.Empty<string>();
}
```

- [ ] **Step 2: Update Constants.cs pass-throughs for FILTER_OPS + SORT_ORDER_***

- [ ] **Step 3: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: 168 / 0 fail.

- [ ] **Step 4: Commit**

```bash
git add server/csharp/MetaObjects/Core/Query/QueryConstants.cs server/csharp/MetaObjects/Constants.cs
git commit -m "refactor(csharp): colocate query vocabulary into Core/Query/ (ADR-0003)"
```

---

## Task 4: `Core/Field/` — field subtypes + field-level attrs + currency

**Files:**
- Create: `server/csharp/MetaObjects/Core/Field/FieldConstants.cs`
- Create: `server/csharp/MetaObjects/Core/Field/FieldSchema.cs` (move `CommonFieldAttrs` from CoreAttrSchemas.cs)
- Modify: `server/csharp/MetaObjects/Constants.cs` (delete FIELD_SUBTYPE_* + FIELD_ATTR_* + AUTO_SET_* + FIELD_ATTR_CURRENCY*; add pass-throughs)
- Modify: `server/csharp/MetaObjects/CoreAttrSchemas.cs` (delete `CommonFieldAttrs` + the currency-attr block)

- [ ] **Step 1: Create FieldConstants.cs**

```csharp
namespace MetaObjects.Core.Field;

/// <summary>
/// Field concern constants — the 15 field subtypes, the field-level attr keys,
/// AUTO_SET semantics, and currency attrs.
/// </summary>
public static class FieldConstants
{
    public const string SUBTYPE_STRING    = "string";
    public const string SUBTYPE_INT       = "int";
    public const string SUBTYPE_SHORT     = "short";
    public const string SUBTYPE_BYTE      = "byte";
    public const string SUBTYPE_LONG      = "long";
    public const string SUBTYPE_DOUBLE    = "double";
    public const string SUBTYPE_FLOAT     = "float";
    public const string SUBTYPE_DECIMAL   = "decimal";
    public const string SUBTYPE_BOOLEAN   = "boolean";
    public const string SUBTYPE_DATE      = "date";
    public const string SUBTYPE_TIME      = "time";
    public const string SUBTYPE_TIMESTAMP = "timestamp";
    public const string SUBTYPE_OBJECT    = "object";
    public const string SUBTYPE_CLASS     = "class";
    public const string SUBTYPE_CURRENCY  = "currency";

    public static readonly IReadOnlyList<string> SUBTYPES = new[]
    {
        Shared.BaseTypes.SUBTYPE_BASE,
        SUBTYPE_STRING, SUBTYPE_INT, SUBTYPE_SHORT, SUBTYPE_BYTE, SUBTYPE_LONG,
        SUBTYPE_DOUBLE, SUBTYPE_FLOAT, SUBTYPE_DECIMAL, SUBTYPE_BOOLEAN,
        SUBTYPE_DATE, SUBTYPE_TIME, SUBTYPE_TIMESTAMP,
        SUBTYPE_OBJECT, SUBTYPE_CLASS, SUBTYPE_CURRENCY,
    };

    // Field-level attrs
    public const string ATTR_REQUIRED              = "required";
    public const string ATTR_UNIQUE                = "unique";
    public const string ATTR_DEFAULT               = "default";
    public const string ATTR_MAX_LENGTH            = "maxLength";
    public const string ATTR_PRECISION             = "precision";
    public const string ATTR_SCALE                 = "scale";
    public const string ATTR_FILTERABLE            = "filterable";
    public const string ATTR_SORTABLE              = "sortable";
    public const string ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";
    public const string ATTR_AUTO_SET              = "autoSet";
    public const string ATTR_OBJECT_REF            = "objectRef";

    // AUTO_SET values
    public const string AUTO_SET_ON_CREATE = "onCreate";
    public const string AUTO_SET_ON_UPDATE = "onUpdate";

    public static readonly IReadOnlyList<string> AUTO_SET_VALUES = new[]
    {
        AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE,
    };

    // Currency attrs (on currency-subtype fields)
    public const string ATTR_CURRENCY         = "currency";
    public const string ATTR_CURRENCY_DEFAULT = "USD";
}
```

- [ ] **Step 2: Create FieldSchema.cs**

Move the `CommonFieldAttrs` definition from `CoreAttrSchemas.cs` into a new `FieldSchema.cs` under `Core/Field/`. The shape (use the actual `AttrSchema` constructor for the project — verify by reading `CoreAttrSchemas.cs` first):

```csharp
using MetaObjects.Registry;     // or wherever AttrSchema lives
using static MetaObjects.Core.Attr.AttrConstants;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Query.QueryConstants;

namespace MetaObjects.Core.Field;

/// <summary>
/// Field-level attribute schemas — attrs common to every field subtype, plus the @currency attr
/// specific to field.currency. Consumed by the core types provider when registering field types.
/// </summary>
public static class FieldSchema
{
    public static readonly IReadOnlyList<AttrSchema> CommonFieldAttrs = new[]
    {
        new AttrSchema(name: ATTR_OBJECT_REF, valueType: SUBTYPE_STRING, required: false,
            description: "Name (or FQN) of the target object an object-typed field nests."),
        new AttrSchema(name: ATTR_REQUIRED, valueType: SUBTYPE_BOOLEAN, required: false,
            description: "When true, the field is NOT NULL."),
        // ... (one entry per attr in CommonFieldAttrs from CoreAttrSchemas.cs)
        // Use the same description text and same allowedValues references — port verbatim.
    };

    public static readonly IReadOnlyList<AttrSchema> CurrencyFieldAttrs = new[]
    {
        new AttrSchema(name: ATTR_CURRENCY, valueType: SUBTYPE_STRING, required: false,
            description: "ISO 4217 currency code on a currency-subtype field. Defaults to USD."),
    };
}
```

**IMPORTANT:** before writing the schema entries verbatim, READ `server/csharp/MetaObjects/CoreAttrSchemas.cs` to find the actual `AttrSchema` constructor signature, allowedValues format, and the exact description strings used. Port them 1:1 — the only change is the source location.

- [ ] **Step 3: Update Constants.cs and CoreAttrSchemas.cs pass-throughs / removals**

In `Constants.cs`, replace the `FIELD_SUBTYPE_*`, `FIELD_ATTR_*`, `AUTO_SET_*`, and currency-attr lines with pass-throughs to `Core.Field.FieldConstants`.

In `CoreAttrSchemas.cs`, delete `CommonFieldAttrs` and `CurrencyFieldAttrs` (or replace with `=> FieldSchema.CommonFieldAttrs.ToList()` pass-through if cross-referenced).

- [ ] **Step 4: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: 168 / 0 fail.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects/Core/Field/FieldConstants.cs server/csharp/MetaObjects/Core/Field/FieldSchema.cs server/csharp/MetaObjects/Constants.cs server/csharp/MetaObjects/CoreAttrSchemas.cs
git commit -m "refactor(csharp): colocate field concern (subtypes, attrs, currency) into Core/Field/ (ADR-0003)"
```

---

## Task 5: `Core/Object/` — object subtypes + object attrs

**Files:**
- Create: `server/csharp/MetaObjects/Core/Object/ObjectConstants.cs`
- Create: `server/csharp/MetaObjects/Core/Object/ObjectSchema.cs`
- Modify: `server/csharp/MetaObjects/Constants.cs` (delete OBJECT_SUBTYPE_*; add pass-throughs)
- Modify: `server/csharp/MetaObjects/CoreAttrSchemas.cs` (delete `ObjectAttrs`)

- [ ] **Step 1: Create ObjectConstants.cs**

```csharp
namespace MetaObjects.Core.Object;

public static class ObjectConstants
{
    public const string SUBTYPE_ENTITY = "entity";
    public const string SUBTYPE_VALUE  = "value";

    public static readonly IReadOnlyList<string> SUBTYPES = new[]
    {
        Shared.BaseTypes.SUBTYPE_BASE, SUBTYPE_ENTITY, SUBTYPE_VALUE,
    };
}
```

- [ ] **Step 2: Create ObjectSchema.cs**

Port `ObjectAttrs` from `CoreAttrSchemas.cs` into `Core/Object/ObjectSchema.cs`. Read the source first to capture the exact entries.

- [ ] **Step 3 + 4 + 5: Update Constants.cs pass-throughs + delete from CoreAttrSchemas.cs + build/test/commit**

```bash
git add server/csharp/MetaObjects/Core/Object/ObjectConstants.cs server/csharp/MetaObjects/Core/Object/ObjectSchema.cs server/csharp/MetaObjects/Constants.cs server/csharp/MetaObjects/CoreAttrSchemas.cs
git commit -m "refactor(csharp): colocate object concern into Core/Object/ (ADR-0003)"
```

---

## Task 6: `Core/Validator/` — validator subtypes + validator attrs

Same shape as Task 5. Port:
- `VALIDATOR_SUBTYPE_*` → `ValidatorConstants.SUBTYPES`
- `VALIDATOR_ATTR_*` → `ValidatorConstants.ATTR_*`
- `MinMaxValidatorAttrs` (and friends) → `ValidatorSchema.cs`

Commit: `refactor(csharp): colocate validator concern into Core/Validator/ (ADR-0003)`

---

## Task 7: `Core/Identity/` — identity subtypes + identity.reference

**Files:**
- Create: `server/csharp/MetaObjects/Core/Identity/IdentityConstants.cs`
- Create: `server/csharp/MetaObjects/Core/Identity/IdentitySchema.cs`

Port:
- `IDENTITY_SUBTYPE_PRIMARY/SECONDARY/REFERENCE`
- `IDENTITY_ATTR_FIELDS/GENERATION/UNIQUE`
- `IDENTITY_REFERENCE_ATTR_REFERENCES/ENFORCE`
- `GENERATION_INCREMENT/UUID/ASSIGNED` + `GENERATION_VALUES`
- `PrimaryIdentityAttrs`, `SecondaryIdentityAttrs`, `ReferenceIdentityAttrs` → IdentitySchema

Commit: `refactor(csharp): colocate identity concern into Core/Identity/ (ADR-0003)`

---

## Task 8: `Core/Relationship/`

Port `RELATIONSHIP_SUBTYPE_*` + `RELATIONSHIP_ATTR_*` + `CARDINALITY_*` + `RelationshipAttrs` schema.

Commit: `refactor(csharp): colocate relationship concern into Core/Relationship/ (ADR-0003)`

---

## Task 9: `Persistence/Source/`

Port `SOURCE_SUBTYPE_DB_TABLE/DB_VIEW`, `SOURCE_ATTR_NAME`, `SOURCE_ATTR_SCHEMA` (the one from the schema-namespacing plan), `DEFAULT_DB_SCHEMA_POSTGRES`, and the source attr-schema entries.

Commit: `refactor(csharp): colocate source concern into Persistence/Source/ (ADR-0003)`

---

## Task 10: `Persistence/Origin/`

Port `ORIGIN_SUBTYPE_PASSTHROUGH/AGGREGATE`, `ORIGIN_PASSTHROUGH_ATTR_*`, `ORIGIN_AGGREGATE_ATTR_*`, `AGGREGATE_FUNCTIONS`, and the origin attr-schema entries.

Commit: `refactor(csharp): colocate origin concern into Persistence/Origin/ (ADR-0003)`

---

## Task 11: `Persistence/Db/`

Port `FIELD_ATTR_DB_COLUMN`, `FIELD_ATTR_DB_INDEXED`, and any other DB-domain attrs.

Commit: `refactor(csharp): colocate db concern into Persistence/Db/ (ADR-0003)`

---

## Task 12: `Presentation/View/`

Port `VIEW_SUBTYPE_*`, `VIEW_CURRENCY_ATTR_LOCALE*`, and view attr-schema entries.

Commit: `refactor(csharp): colocate view concern into Presentation/View/ (ADR-0003)`

---

## Task 13: `Presentation/Layout/`

Port `LAYOUT_SUBTYPE_DATA_GRID` + the 5 `LAYOUT_DATA_GRID_ATTR_*` (pageSize, defaultSortField, defaultSortOrder, filterable, filter, columns) + the dataGrid attrs schema.

Commit: `refactor(csharp): colocate layout concern into Presentation/Layout/ (ADR-0003)`

---

## Task 14: Replace `CoreTypes.cs` with per-concern self-registration

**Files:**
- Modify: each per-concern folder gets a `<Concern>Types.cs` exposing `RegisterTypes(TypeRegistry)`
- Modify: `server/csharp/MetaObjects/CoreTypes.cs` → reduce to a composition: each concern's RegisterTypes is called

- [ ] **Step 1: For each concern, factor its type-registration block out of `RegisterCoreTypeDefs`**

Currently `CoreTypes.cs:170 RegisterCoreTypeDefs` builds Defs for: metadata, object (each subtype), field (each subtype), attr (each subtype), validator (each subtype), identity (each subtype), relationship (each subtype), view (each subtype), layout (each subtype), source (each subtype), origin (each subtype).

Move each block into its concern folder as a static method:

```csharp
// Core/Object/ObjectTypes.cs
namespace MetaObjects.Core.Object;

public static class ObjectTypes
{
    public static void RegisterTypes(TypeRegistry registry)
    {
        List<ChildRule> rules = new() { /* ... per current code ... */ };
        foreach (string subType in ObjectConstants.SUBTYPES)
        {
            registry.Register(Def(
                Shared.BaseTypes.TYPE_OBJECT, subType, $"Object/entity ({subType})",
                rules, (tid, n) => new MetaObject(tid, n),
                ObjectSchema.ObjectAttrs.ToList()));
        }
    }
}
```

Similarly for each concern. The `Def` helper, `ChildRule.Wildcard`, etc. — port to the appropriate `using` statements.

- [ ] **Step 2: Reduce `CoreTypes.cs` to a thin composition**

```csharp
namespace MetaObjects;

public static class CoreTypes
{
    public static IMetaDataTypeProvider Provider { get; } = new CoreTypesProvider();

    private sealed class CoreTypesProvider : IMetaDataTypeProvider
    {
        public string Id => "metaobjects-core-types";
        public IReadOnlyList<string> Dependencies => Array.Empty<string>();

        public void RegisterTypes(TypeRegistry registry)
        {
            Core.Attr.AttrTypes.RegisterTypes(registry);
            Core.Object.ObjectTypes.RegisterTypes(registry);
            Core.Field.FieldTypes.RegisterTypes(registry);
            Core.Validator.ValidatorTypes.RegisterTypes(registry);
            Core.Identity.IdentityTypes.RegisterTypes(registry);
            Core.Relationship.RelationshipTypes.RegisterTypes(registry);
            Persistence.Source.SourceTypes.RegisterTypes(registry);
            Persistence.Origin.OriginTypes.RegisterTypes(registry);
            Persistence.Db.DbTypes.RegisterTypes(registry);
            Presentation.View.ViewTypes.RegisterTypes(registry);
            Presentation.Layout.LayoutTypes.RegisterTypes(registry);
            // metadata.root registration stays here (it's the document root, not a concern)
            RegisterMetadataRoot(registry);
        }

        private static void RegisterMetadataRoot(TypeRegistry registry) { /* ... */ }
    }
}
```

- [ ] **Step 3: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: 168 / 0 fail. **This is the critical test** — the registration order now flows through concern providers; conformance must remain identical.

- [ ] **Step 4: Commit**

```bash
git add server/csharp/MetaObjects/**/*.cs
git commit -m "refactor(csharp): self-registering per-concern types via composed CoreTypesProvider (ADR-0004)"
```

---

## Task 15: Final cleanup — delete `Constants.cs` and `CoreAttrSchemas.cs`

At this point both god-files are pure pass-through shims with every constant redirected to its per-concern home. Delete them, fix the cascading import errors by updating callers.

**Files:**
- Delete: `server/csharp/MetaObjects/Constants.cs`
- Delete: `server/csharp/MetaObjects/CoreAttrSchemas.cs`
- Modify: every C# file that imports `MetaObjects.Constants.FOO` or `MetaObjects.CoreAttrSchemas.BAR` — replace with the per-concern import

- [ ] **Step 1: Grep for `Constants.` and `CoreAttrSchemas.` usages**

```bash
cd server/csharp && grep -rln "MetaObjects\.Constants\|using static MetaObjects\.Constants\|CoreAttrSchemas\." --include="*.cs" | head -30
```

- [ ] **Step 2: For each file, replace `Constants.X` and `CoreAttrSchemas.Y` with the per-concern path**

Mechanical refactor: `Constants.FIELD_ATTR_REQUIRED` → `FieldConstants.ATTR_REQUIRED` (with `using MetaObjects.Core.Field;` at the top). Same for every other.

- [ ] **Step 3: Delete the two files**

```bash
git rm server/csharp/MetaObjects/Constants.cs server/csharp/MetaObjects/CoreAttrSchemas.cs
```

- [ ] **Step 4: Build + test**

```bash
cd server/csharp && dotnet build && dotnet test MetaObjects.Conformance.Tests
```

Expected: 168 / 0 fail. No file references `Constants` or `CoreAttrSchemas` anymore.

- [ ] **Step 5: Final commit**

```bash
git add server/csharp
git commit -m "refactor(csharp): delete Constants.cs + CoreAttrSchemas.cs god-files (ADR-0003 realization complete)"
```

---

## Self-Review

**1. Spec coverage** — each concern in the TS structure has an equivalent C# task. Compare against the realized TS layout:

| Concern | TS path | C# task |
|---|---|---|
| Shared base types | `shared/base-types.ts` | Task 1 |
| Attr subtypes | `core/attr/attr-constants.ts` | Task 2 |
| Query vocab | `core/query/query-constants.ts` | Task 3 |
| Field | `core/field/{field-constants,field-schema}.ts` | Task 4 |
| Object | `core/object/{...}` | Task 5 |
| Validator | `core/validator/{...}` | Task 6 |
| Identity | `core/identity/{...}` | Task 7 |
| Relationship | `core/relationship/{...}` | Task 8 |
| Source | `persistence/source/{...}` | Task 9 |
| Origin | `persistence/origin/{...}` | Task 10 |
| Db | `persistence/db/{...}` | Task 11 |
| View | `presentation/view/{...}` | Task 12 |
| Layout | `presentation/layout/{...}` | Task 13 |
| Provider composition (ADR-0004) | TS `composeRegistry` | Task 14 |
| Delete god-files | `constants.ts` + `core-attr-schemas.ts` deleted | Task 15 |

**2. Placeholder scan** — Task 6-13 use compressed task descriptions (3-5 lines instead of full code) because they all follow the EXACT shape of Tasks 4 and 5. The implementer should refer back to those as templates. Each task lists its specific constants + the schema/types entries.

**3. Type consistency**

- `IMetaDataTypeProvider` is the existing C# interface — verified in `server/csharp/MetaObjects/Provider.cs`
- `TypeRegistry`, `ChildRule.Wildcard`, `Def` helper — used as-is per current C# patterns
- The `AttrSchema` shape from `CoreAttrSchemas.cs` is read verbatim by each Schema task

**4. Scope check**

15 tasks. Each commits independently with conformance green. The plan ships as a single coherent refactor — same Open-Closed contract as TS, same conformance guarantee.

---

## Done When

- `Constants.cs` and `CoreAttrSchemas.cs` no longer exist
- Every concern under `Core/`, `Persistence/`, `Presentation/`, `Shared/`
- `CoreTypes.cs` reduced to a composed `CoreTypesProvider` calling per-concern `RegisterTypes`
- `dotnet test MetaObjects.Conformance.Tests` = 168 / 0 fail
- C# state matches the "Realization status: shipped" entry of ADR-0003 + ADR-0004
- Any caller using `using static MetaObjects.Constants;` updated to per-concern imports
