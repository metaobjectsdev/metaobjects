# C# Conformance Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a C# implementation of the MetaObjects Loader + canonical serializer that runs the shared `fixtures/conformance/` corpus and passes every fixture, byte-identical to the TypeScript reference.

**Architecture:** The TypeScript `@metaobjectsdev/metadata` package is the **oracle** — its behavior is the spec. We port its pipeline (registry → JSON parser → multi-file loader → super resolution → validation passes → canonical serializer) into idiomatic C#. The conformance corpus decides pass/fail; we never edit a fixture to make the port green. Build proceeds in vertical slices, each ending with more fixtures verified green and the rest parked in an expected-failures ledger so `dotnet test` stays green throughout.

**Two load-bearing design constraints (from review):**
- **The parser is purely provider/registry-driven.** It holds *zero* hardcoded type or subtype knowledge — every type, subtype, attr schema, child rule, default subtype, and node factory comes from the `TypeRegistry` composed from `IMetaDataTypeProvider`s. A future provider that registers a brand-new type/subtype is parsed correctly with no parser change. The only metamodel strings the parser knows are the *structural* reserved keys (`name`, `package`, `extends`, `children`, the `@` prefix, the `.` type/subtype separator) — never a concrete type name like `object` or `field`.
- **Loading goes through `MetaDataSource`.** The core pipeline is `MetaDataLoader.Load(IReadOnlyList<IMetaDataSource>)`. A `MetaDataSource` is one unit of raw input (`FileSource`, `InMemorySource`, later a URL source). `FileMetaDataLoader` is a thin subclass that *discovers* file-backed sources (`LoadDirectory`, `LoadFiles`) and delegates to the base pipeline. This mirrors the Java H3a refactor that routes all loading through `load(List<MetaDataSource>)`.

**Tech Stack:** .NET 8 (`dotnet` 8.0.126 installed), C# 12, `System.Text.Json` for parse + serialize, xUnit for the conformance test project.

**Tier discipline (from the cross-language-porting skill):**
- **Tier 1 — Invariant, never change:** metamodel vocabulary (type/subtype names, reserved keys, `@`-prefix, `::`/`.` separators), canonical wire format, error codes, observable load semantics. These are ported verbatim.
- **Tier 2 — Idiomatic, make native to C#:** API naming (PascalCase methods, properties), null representation (`null` not `undefined`), collections (`IReadOnlyList<T>`), error handling (collected `MetaError` records, not thrown JS `Error` objects), async (`loadDirectory` may be sync — file I/O is fast and the corpus is tiny).
- **Tier 3 — Free:** internal file layout, private helper shape, performance.

**Reference map (TS file → what to port):**

| TS source (`typescript/packages/metadata/src/`) | C# target |
|---|---|
| `constants.ts` | `MetaObjects/Constants.cs` |
| `errors.ts` | `MetaObjects/Errors.cs` |
| `data-type.ts`, `data-converter.ts` | `MetaObjects/DataType.cs`, `MetaObjects/DataConverter.cs` |
| `registry.ts` | `MetaObjects/Registry.cs` |
| `provider.ts` | `MetaObjects/Provider.cs` |
| `meta/meta-data.ts` + `meta/meta-*.ts` | `MetaObjects/Meta/*.cs` |
| `core-attr-schemas.ts`, `core-types.ts` | `MetaObjects/CoreAttrSchemas.cs`, `MetaObjects/CoreTypes.cs` |
| `parser-core.ts`, `parser-json.ts` | `MetaObjects/Parser.cs` |
| `super-resolve.ts` | `MetaObjects/SuperResolve.cs` |
| `loader/meta-data-source.ts`, `core/file-source.ts` | `MetaObjects/Loader/MetaDataSource.cs`, `FileSource.cs` |
| `loader/meta-data-loader.ts` | `MetaObjects/Loader/MetaDataLoader.cs` |
| `core/file-meta-data-loader.ts` | `MetaObjects/Loader/FileMetaDataLoader.cs` |
| `loader/validation-passes.ts`, `subtype-rules.ts`, `attr-schema-validate.ts` | `MetaObjects/Loader/ValidationPasses.cs` |
| `serializer-json.ts` | `MetaObjects/SerializerJson.cs` |
| `typescript/packages/conformance/src/*` + `test/conformance/*` | `MetaObjects.Conformance.Tests/*` |

**Porting rule for every task below:** open the named TS source file and translate it. The plan gives the C# shape, the verification, and the C#-specific gotchas — it does **not** restate every line of TS, because the TS file is the authoritative spec and re-deriving from prose produces subtly-wrong behavior.

---

## File Structure

```
csharp/
├── MetaObjects.sln
├── MetaObjects/                          # class library (net8.0, no OutputType=Exe)
│   ├── MetaObjects.csproj
│   ├── Constants.cs
│   ├── Errors.cs
│   ├── DataType.cs
│   ├── DataConverter.cs
│   ├── Registry.cs                       # TypeId, ChildRule, AttrSchema, TypeDefinition, TypeRegistry
│   ├── Provider.cs                       # IMetaDataTypeProvider, ComposeRegistry
│   ├── CoreAttrSchemas.cs
│   ├── CoreTypes.cs                      # CoreTypesProvider, registerCoreTypes
│   ├── Parser.cs                         # BuildTree pipeline
│   ├── SuperResolve.cs
│   ├── SerializerJson.cs
│   ├── Meta/
│   │   ├── MetaData.cs                   # abstract base
│   │   ├── MetaRoot.cs   MetaObject.cs   MetaField.cs   MetaAttr.cs
│   │   ├── MetaValidator.cs              # base + Required/Length/Regex/Numeric/Array
│   │   ├── MetaView.cs   MetaLayout.cs   MetaSource.cs  MetaRelationship.cs
│   │   ├── MetaIdentity.cs               # base + Primary/Secondary
│   │   └── MetaOrigin.cs                 # base + Passthrough/Aggregate
│   └── Loader/
│       ├── MetaDataSource.cs              # IMetaDataSource, MetaDataFormat, InMemorySource
│       ├── FileSource.cs                 # IMetaDataSource backed by a file on disk
│       ├── MetaDataLoader.cs             # core pipeline: Load(IReadOnlyList<IMetaDataSource>)
│       ├── FileMetaDataLoader.cs         # MetaDataLoader + LoadDirectory / LoadFiles
│       └── ValidationPasses.cs
└── MetaObjects.Conformance.Tests/        # xUnit test project (net8.0)
    ├── MetaObjects.Conformance.Tests.csproj
    ├── CorpusRoot.cs                     # locates fixtures/conformance/
    ├── FixtureDiscovery.cs               # walks fixtures/conformance/* (+ providers.json)
    ├── FixtureLint.cs                    # corpus-integrity lint (port of fixture-lint.ts)
    ├── OperationScript.cs                # script.json + expected-errors.json parsers
    ├── Result.cs                         # NormalizedResult + resultsEqual (Slice 7)
    ├── ConformanceAdapter.cs             # loadFixture / canonicalSerialize / navigate / invoke
    ├── Navigator.cs                      # navigate-path interpreter (Slice 7)
    ├── CapabilityBinding.cs              # capability dispatch table (Slice 7)
    ├── ExpectedFailures.cs               # ledger load + classify
    ├── conformance-expected-failures.json
    ├── ConformanceTests.cs               # the [Theory] — lint + conformance
    └── TreeTests.cs / ParserTests.cs / ... # per-slice unit tests
```

The existing `csharp/` spike (`MetaData.cs`, `MetaObject.cs`, `MetaField.cs`, `Program.cs`, `MetaObjects.csproj`) is **replaced** — the spike's accessors are subsumed by the full port. Delete `Program.cs`, `bin/`, `obj/` in Task 0.1.

---

## Slice 0 — Solution scaffold + stable foundation

Goal: a building solution with the constants, error types, and registry — no behavior yet.

### Task 0.1: Restructure into a solution

**Files:**
- Delete: `csharp/MetaData.cs`, `csharp/MetaObject.cs`, `csharp/MetaField.cs`, `csharp/Program.cs`, `csharp/MetaObjects.csproj`, `csharp/bin/`, `csharp/obj/`
- Create: `csharp/MetaObjects/MetaObjects.csproj`, `csharp/MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj`, `csharp/MetaObjects.sln`

- [ ] **Step 1: Remove the spike files**

```bash
cd csharp && rm -f MetaData.cs MetaObject.cs MetaField.cs Program.cs MetaObjects.csproj && rm -rf bin obj
```

- [ ] **Step 2: Create the library project** `csharp/MetaObjects/MetaObjects.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>12</LangVersion>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <RootNamespace>MetaObjects</RootNamespace>
  </PropertyGroup>
</Project>
```

- [ ] **Step 3: Create the test project** `csharp/MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../MetaObjects/MetaObjects.csproj" />
  </ItemGroup>
</Project>
```

- [ ] **Step 4: Create the solution and add both projects**

```bash
cd csharp && dotnet new sln --name MetaObjects \
  && dotnet sln add MetaObjects/MetaObjects.csproj MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj
```

- [ ] **Step 5: Add a trivial placeholder so the solution builds**

Create `csharp/MetaObjects/Placeholder.cs`:

```csharp
namespace MetaObjects;

/// <summary>Removed in Slice 0 Task 0.2 once Constants.cs lands.</summary>
internal static class Placeholder { }
```

- [ ] **Step 6: Verify the solution builds**

Run: `cd csharp && dotnet build`
Expected: `Build succeeded`, 0 errors.

- [ ] **Step 7: Commit**

```bash
cd <repo-root> && git add -A csharp \
  && git commit -m "chore(csharp): restructure spike into MetaObjects solution + test project"
```

### Task 0.2: Port constants

**Files:**
- Create: `csharp/MetaObjects/Constants.cs`
- Delete: `csharp/MetaObjects/Placeholder.cs`

- [ ] **Step 1: Port `constants.ts` verbatim**

Open `typescript/packages/metadata/src/constants.ts`. Translate every exported `const` to a `public const string` (or `public static readonly string[]`) inside `public static class Constants` in namespace `MetaObjects`. Naming is a 1:1 transliteration: `TYPE_OBJECT` → `Constants.TypeObject`? **No** — keep the SCREAMING_SNAKE names as C# `const` identifiers (`public const string TYPE_OBJECT = "object";`) so cross-language grep parity is preserved. This is a Tier 3 choice locked here: **screaming-snake const names, matching the TS identifiers exactly.**

Port these groups: base type names + `BASE_TYPES`; `SUBTYPE_BASE`, `SUBTYPE_ROOT`; object/field/attr/validator/view/layout/identity/relationship/source/origin subtype constants and their arrays; reserved keys + `RESERVED_KEYS` (a `HashSet<string>`); `JSON_KEY_SCHEMA`; `ATTR_PREFIX`, `TYPE_SUBTYPE_SEPARATOR`; `PACKAGE_SEPARATOR`, `PACKAGE_PARENT`; `CHILD_RULE_WILDCARD`; all the attr-key constants (identity/relationship/field/validator/origin/source/layout/view); the enum-value constants (`AUTO_SET_*`, `SORT_ORDER_*`, `GENERATION_*`, `CARDINALITY_*`, aggregate functions); `FILTER_OPS`, `OPS_BY_SUBTYPE` (a `Dictionary<string, string[]>`), `opsForSubType`.

Delete `Placeholder.cs`.

- [ ] **Step 2: Verify it builds**

Run: `cd csharp && dotnet build MetaObjects/MetaObjects.csproj`
Expected: `Build succeeded`, 0 errors, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port metamodel constants"
```

### Task 0.3: Port error types

**Files:**
- Create: `csharp/MetaObjects/Errors.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/ErrorsTests.cs`

- [ ] **Step 1: Write the failing test** `ErrorsTests.cs`

```csharp
using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ErrorsTests
{
    [Fact]
    public void MetaError_carries_a_stable_code()
    {
        var e = new MetaError("bad metadata", ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.Equal(ErrorCode.ERR_UNKNOWN_TYPE, e.Code);
        Assert.Equal("bad metadata", e.Message);
    }

    [Fact]
    public void ErrorCode_names_match_the_corpus_ledger()
    {
        Assert.Contains(ErrorCode.ERR_MALFORMED_JSON, System.Enum.GetValues<ErrorCode>());
        Assert.Contains(ErrorCode.ERR_OVERLAY_NO_TARGET, System.Enum.GetValues<ErrorCode>());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test`
Expected: FAIL — `MetaError` / `ErrorCode` do not exist.

- [ ] **Step 3: Implement `Errors.cs`**

Port `errors.ts`. Idiomatic C# (Tier 2): the TS code has both thrown `ParseError`/`MetaModelError` *and* collected error arrays. The C# port collects everything — model **one** record type and **one** enum:

```csharp
namespace MetaObjects;

/// <summary>Stable, language-neutral error codes — mirrors fixtures/conformance/ERROR-CODES.json.</summary>
public enum ErrorCode
{
    ERR_MALFORMED_JSON, ERR_TOP_LEVEL_NOT_OBJECT, ERR_UNKNOWN_TYPE, ERR_UNKNOWN_SUBTYPE,
    ERR_MISSING_SUBTYPE, ERR_DUPLICATE_NAME, ERR_UNRESOLVED_SUPER, ERR_INVALID_SUBTYPE_CHILD,
    ERR_UNKNOWN_ATTR, ERR_MISSING_REQUIRED_ATTR, ERR_BAD_ATTR_VALUE, ERR_BAD_DEFAULT_SORT_FIELD,
    ERR_PROVIDER_DEPENDENCY_CYCLE, ERR_PROVIDER_DUPLICATE_ID, ERR_PROVIDER_MISSING_DEPENDENCY,
    ERR_PROVIDER_ATTR_CONFLICT, ERR_SUBTYPE_RULE_VIOLATION, ERR_OVERLAY_NO_TARGET,
    ERR_MALFORMED_YAML, ERR_INVALID_ORIGIN, ERR_UNKNOWN,
}

/// <summary>A collected load error. Carries the stable code the conformance runner compares.</summary>
public sealed record MetaError(string Message, ErrorCode Code = ErrorCode.ERR_UNKNOWN,
    string? Source = null, string? Path = null);

/// <summary>Thrown for top-level structural parse failures the TS parser also throws on
/// (malformed JSON, non-object root, unknown root type). The loader catches it and
/// converts to a collected <see cref="MetaError"/>.</summary>
public sealed class ParseException : System.Exception
{
    public ErrorCode Code { get; }
    public string? Source { get; }
    public string? NodePath { get; }
    public ParseException(string message, ErrorCode code = ErrorCode.ERR_UNKNOWN,
        string? source = null, string? nodePath = null) : base(message)
        => (Code, Source, NodePath) = (code, source, nodePath);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd csharp && dotnet test`
Expected: PASS — both `ErrorsTests` tests green.

- [ ] **Step 5: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port error codes + MetaError/ParseException"
```

### Task 0.4: Port the registry + provider model

**Files:**
- Create: `csharp/MetaObjects/Registry.cs`, `csharp/MetaObjects/Provider.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/RegistryTests.cs`

- [ ] **Step 1: Write the failing test** `RegistryTests.cs`

```csharp
using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class RegistryTests
{
    [Fact]
    public void Register_then_find_round_trips()
    {
        var reg = new TypeRegistry();
        reg.Register(new TypeDefinition(
            new TypeId("object", "entity"), "test", new List<ChildRule>(),
            (id, name) => throw new System.NotImplementedException(),
            new List<AttrSchema>()));
        Assert.True(reg.Has("object", "entity"));
        Assert.Equal(new[] { "entity" }, reg.AllSubTypesOf("object"));
    }

    [Fact]
    public void Register_duplicate_throws()
    {
        var reg = new TypeRegistry();
        TypeDefinition Make() => new(new TypeId("object", "entity"), "t",
            new List<ChildRule>(), (id, n) => throw new System.NotImplementedException(),
            new List<AttrSchema>());
        reg.Register(Make());
        Assert.Throws<System.InvalidOperationException>(() => reg.Register(Make()));
    }

    [Fact]
    public void ComposeRegistry_detects_a_dependency_cycle()
    {
        var a = new DelegateProvider("a", new[] { "b" });
        var b = new DelegateProvider("b", new[] { "a" });
        var ex = Assert.Throws<MetaModelException>(() => Provider.ComposeRegistry(new[] { a, b }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE, ex.Code);
    }
}

/// <summary>Test-only provider whose registerTypes is a no-op.</summary>
file sealed class DelegateProvider(string id, string[] deps) : IMetaDataTypeProvider
{
    public string Id => id;
    public IReadOnlyList<string> Dependencies => deps;
    public void RegisterTypes(TypeRegistry registry) { }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter RegistryTests`
Expected: FAIL — `TypeRegistry`, `TypeId`, etc. do not exist.

- [ ] **Step 3: Implement `Registry.cs`**

Port `registry.ts`. C# shapes:
- `TypeId` — `public sealed record TypeId(string Type, string SubType)` with `public override string ToString() => $"{Type}.{SubType}";`. Record equality replaces `equals()`.
- `ChildRule` — `public sealed record ChildRule(string ChildType, string ChildSubType, string ChildName);`
- `AttrSchema` — `public sealed record AttrSchema(string Name, string? ValueType, bool Required, object? Default = null, IReadOnlyList<object>? AllowedValues = null, string Description = "");`
- `TypeDefinition` — class (mutable: `extend` appends to `Attributes`/`ChildRules`): `Attributes` is `List<AttrSchema>`, `ChildRules` is `List<ChildRule>`, `Factory` is `Func<TypeId, string, MetaData>`, `DataType? DataType`.
- `TypeRegistry` — port `register`, `find`, `has`, `allTypes`, `allSubTypesOf`, `setDefaultSubType`, `defaultSubTypeOf`, `attrsOf`, `extend`, plus the standalone `childRuleMatches`. Duplicate registration → `throw new InvalidOperationException(...)`. `valueType == SUBTYPE_BASE` rejection in `register`/`extend` → `InvalidOperationException`. The `extend` attr-conflict → `throw new MetaModelException(msg, ErrorCode.ERR_PROVIDER_ATTR_CONFLICT)`.

Add `MetaModelException` to `Errors.cs` (port `MetaModelError`):

```csharp
public sealed class MetaModelException(string message, ErrorCode code = ErrorCode.ERR_UNKNOWN)
    : System.Exception(message) { public ErrorCode Code => code; }
```

`MetaData` doesn't exist yet — `TypeDefinition.Factory` references it. Add a minimal `namespace MetaObjects { public abstract class MetaData { } }` stub in `Meta/MetaData.cs` now; Slice 1 Task 1.3 replaces it fully.

- [ ] **Step 4: Implement `Provider.cs`**

Port `provider.ts`. `IMetaDataTypeProvider` interface (`Id`, `Dependencies`, `RegisterTypes`). `Provider.ComposeRegistry(IReadOnlyList<IMetaDataTypeProvider>)` — port the duplicate-id / missing-dependency / stable-topo-sort logic; all three failures `throw new MetaModelException(msg, <code>)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter RegistryTests`
Expected: PASS — 3 tests green.

- [ ] **Step 6: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port TypeRegistry + provider composition"
```

---

## Slice 1 — Value model + the typed MetaData tree

Goal: the immutable typed-tree with super-chain-aware effective accessors. Verified by unit tests mirroring `test/meta/` and `test/super-resolve.test.ts`.

### Task 1.1: Port the DataType vocabulary

**Files:**
- Create: `csharp/MetaObjects/DataType.cs`
- Test: extend `csharp/MetaObjects.Conformance.Tests/` later — no standalone test (covered by DataConverter test in 1.2).

- [ ] **Step 1: Port `data-type.ts`**

Open `typescript/packages/metadata/src/data-type.ts`. Port the `DATA_TYPE_*` set. Model `DataType` as an `enum DataType { String, Int, Long, Double, Boolean, Date, Object }` and `public const string` names if the TS file exposes string constants. Match the TS file exactly — if it has helper functions, port them.

- [ ] **Step 2: Verify build**

Run: `cd csharp && dotnet build MetaObjects/MetaObjects.csproj`
Expected: `Build succeeded`.

- [ ] **Step 3: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port DataType vocabulary"
```

### Task 1.2: Port the data converter + the AttrValue model

**Files:**
- Create: `csharp/MetaObjects/DataConverter.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/DataConverterTests.cs`

**AttrValue representation (Tier 2 decision, locked here):** TS `AttrValue = string | number | boolean | string[]`. C# stores attr values as `object?` constrained at runtime to exactly: `string`, `long`, `double`, `bool`, or `IReadOnlyList<string>`. A `long` (never `int`) carries every integer; a `double` carries non-integers. This keeps the canonical serializer's number handling single-path. Document this contract in a comment at the top of `DataConverter.cs`.

- [ ] **Step 1: Write the failing test** `DataConverterTests.cs`

```csharp
using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class DataConverterTests
{
    [Fact]
    public void ToAttrValue_preserves_json_scalar_types()
    {
        Assert.Equal("hi", DataConverter.ToAttrValue(System.Text.Json.JsonDocument.Parse("\"hi\"").RootElement));
        Assert.Equal(42L, DataConverter.ToAttrValue(System.Text.Json.JsonDocument.Parse("42").RootElement));
        Assert.Equal(true, DataConverter.ToAttrValue(System.Text.Json.JsonDocument.Parse("true").RootElement));
    }

    [Fact]
    public void ConvertToDataType_coerces_toward_the_target()
    {
        Assert.Equal(7L, DataConverter.ConvertToDataType(DataType.Long,
            System.Text.Json.JsonDocument.Parse("7").RootElement));
    }
}
```

(Adjust the signatures if `data-converter.ts` exposes a different surface — read it first; the test must match the ported API.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter DataConverterTests`
Expected: FAIL — `DataConverter` does not exist.

- [ ] **Step 3: Implement `DataConverter.cs`**

Port `data-converter.ts` (`convertToDataType`, `toAttrValue`). The TS input is a parsed JS value; the C# input is a `System.Text.Json.JsonElement` (the parser hands raw JSON values straight through). Convert:
- `JsonValueKind.String` → `string`
- `JsonValueKind.Number` → `long` if `TryGetInt64` succeeds, else `double`
- `JsonValueKind.True/False` → `bool`
- `JsonValueKind.Array` → `IReadOnlyList<string>` (every element must be a string; otherwise the TS code's behavior — read it and match)
- coercion failures → `throw new System.FormatException(...)` (the parser catches and reports `ERR_BAD_ATTR_VALUE`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter DataConverterTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port data converter + AttrValue model"
```

### Task 1.3: Port the MetaData base class

**Files:**
- Modify (replace the stub): `csharp/MetaObjects/Meta/MetaData.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/TreeTests.cs`

- [ ] **Step 1: Write the failing test** `TreeTests.cs`

```csharp
using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class TreeTests
{
    private static MetaObject Obj(string subType, string name) => new(new TypeId("object", subType), name);
    private static MetaField Fld(string subType, string name) => new(new TypeId("field", subType), name);

    [Fact]
    public void Effective_children_include_super_chain_with_own_shadowing()
    {
        var bas = Obj("entity", "Base");
        bas.AddChild(Fld("long", "id"));
        var sub = Obj("entity", "Sub");
        sub.AddChild(Fld("string", "email"));
        sub.SetSuperResolved(bas);
        bas.Freeze(); sub.Freeze();

        var names = sub.Children().Select(c => c.Name).ToArray();
        Assert.Equal(new[] { "id", "email" }, names);
        Assert.Equal(new[] { "email" }, sub.OwnChildren().Select(c => c.Name).ToArray());
    }

    [Fact]
    public void Freeze_blocks_mutation()
    {
        var o = Obj("entity", "X");
        o.Freeze();
        Assert.Throws<System.InvalidOperationException>(() => o.AddChild(Fld("int", "n")));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter TreeTests`
Expected: FAIL — `MetaObject`/`MetaField` not defined.

- [ ] **Step 3: Implement `MetaData.cs`**

Port `meta/meta-data.ts` fully into `namespace MetaObjects.Meta`. Method names PascalCase (Tier 2): `Type`, `SubType`, `Name`, `Package`, `SuperRef`, `IsAbstract`, `IsArray`, `IsMerge`, `Fqn()`, `SetPackage`, `SetSuper`, `SetSuperResolved`, `SuperData`, `SetIsArray`, `SetIsAbstract`, `SetIsMerge`, `SetDataType`, `SetAttr`, `OwnAttr`, `OwnAttrs`, `OwnHasAttr`, `Attrs`, `Attr`, `HasAttr`, `AddChild`, `Parent`, `Root`, `OwnChildren`, `OwnChildrenOfType`, `OwnChildrenOfSubType`, `OwnChildByName`, `OwnChildByTypeAndName`, `Children`, `ChildrenOfType`, `ChildrenOfSubType`, `ChildByName`, `ChildByTypeAndName`, `Freeze`, `IsFrozen`.

Port these algorithms **exactly** — they are Tier 1 observable semantics:
- `_effectiveAttrs` / `_effectiveChildren` — super-chain merge with own-shadows-super-on-(type,name) and append-non-overriding. Use a `HashSet<MetaData>` visited set (reference equality — `MetaData` must NOT override `Equals`; keep reference identity).
- `cached<T>` — only memoize once frozen.
- Freeze guard — `_assertNotFrozen()` throws `InvalidOperationException`.

`AttrValue` is `object?` per Task 1.2. Constructor takes `(TypeId typeId, string name)`.

- [ ] **Step 4: Implement the leaf node stubs needed to compile the test**

Create `Meta/MetaObject.cs` and `Meta/MetaField.cs` as minimal subclasses (full accessors come in Task 1.4):

```csharp
namespace MetaObjects.Meta;
public class MetaObject(TypeId typeId, string name) : MetaData(typeId, name) { }
```

```csharp
namespace MetaObjects.Meta;
public class MetaField(TypeId typeId, string name) : MetaData(typeId, name) { }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter TreeTests`
Expected: PASS — 2 tests green.

- [ ] **Step 6: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port MetaData base — typed tree with super-chain effective accessors"
```

### Task 1.4: Port all concrete node classes

**Files:**
- Create/replace: `csharp/MetaObjects/Meta/MetaRoot.cs`, `MetaObject.cs`, `MetaField.cs`, `MetaAttr.cs`, `MetaValidator.cs`, `MetaView.cs`, `MetaLayout.cs`, `MetaSource.cs`, `MetaRelationship.cs`, `MetaIdentity.cs`, `MetaOrigin.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/NodeAccessorTests.cs`

- [ ] **Step 1: Write the failing test** `NodeAccessorTests.cs`

```csharp
using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class NodeAccessorTests
{
    [Fact]
    public void MetaObject_exposes_fields_own_and_effective_and_primary_identity()
    {
        var bas = new MetaObject(new TypeId("object", "entity"), "Base");
        bas.AddChild(new MetaField(new TypeId("field", "long"), "id"));
        var sub = new MetaObject(new TypeId("object", "entity"), "Sub");
        sub.AddChild(new MetaField(new TypeId("field", "string"), "email"));
        sub.AddChild(new MetaPrimaryIdentity(new TypeId("identity", "primary"), "pk"));
        sub.SetSuperResolved(bas);
        bas.Freeze(); sub.Freeze();

        Assert.Equal(new[] { "id", "email" }, sub.Fields().Select(f => f.Name).ToArray());
        Assert.Equal(new[] { "email" }, sub.OwnFields().Select(f => f.Name).ToArray());
        Assert.Equal("email", sub.FindField("email")!.Name);
        Assert.Equal("primary", sub.PrimaryIdentity()!.SubType);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter NodeAccessorTests`
Expected: FAIL — `MetaPrimaryIdentity` / `Fields()` not defined.

- [ ] **Step 3: Port every `meta/meta-*.ts` node class**

For each TS file in `typescript/packages/metadata/src/meta/`, port the class into `csharp/MetaObjects/Meta/`:
- `MetaRoot` — extends `MetaData`.
- `MetaObject` — `Fields()` (effective `MetaField` children), `OwnFields()`, `FindField(name)`, `PrimaryIdentity()` (effective `identity` child with subType `primary`).
- `MetaField` — `Validators()` (effective `validator` children), `IsRequired` (getter — see `binding.ts`: it's a property), `MaxLength` (getter, `long?`), `DataType` getter.
- `MetaAttr` — extends `MetaData`; `DataType` getter.
- `MetaValidator` + `MetaRequiredValidator`, `MetaLengthValidator`, `MetaRegexValidator`, `MetaNumericValidator`, `MetaArrayValidator`.
- `MetaView`, `MetaLayout`, `MetaSource`, `MetaRelationship`.
- `MetaIdentity` + `MetaPrimaryIdentity`, `MetaSecondaryIdentity`.
- `MetaOrigin` + `MetaPassthroughOrigin`, `MetaAggregateOrigin`.

Every constructor signature is `(TypeId typeId, string name)` — required by `TypeDefinition.Factory`. Read each TS file; port its accessors exactly (these feed the capability binding in Slice 7).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter NodeAccessorTests`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite still builds + passes**

Run: `cd csharp && dotnet test`
Expected: PASS — all Slice 0 + Slice 1 tests green.

- [ ] **Step 6: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port all concrete MetaData node classes"
```

---

## Slice 2 — Core types provider

Goal: a `TypeRegistry` populated with the core metamodel — every `(type, subType)` the fixtures use.

### Task 2.1: Port the core attr schemas

**Files:**
- Create: `csharp/MetaObjects/CoreAttrSchemas.cs`

- [ ] **Step 1: Port `core-attr-schemas.ts`**

Open `typescript/packages/metadata/src/core-attr-schemas.ts`. It is ~320 lines of declarative `AttrSchema` data. Port every exported value (`commonFieldAttrs`, `currencyFieldAttr`, `currencyViewAttrs`, `objectAttrs`, `relationshipAttrs`, `identityFieldsAttr`, `dataGridLayoutAttrs`, `ORIGIN_ATTRS_MAP`, `IDENTITY_ATTRS_MAP`, `VALIDATOR_ATTRS_MAP`) as `public static readonly` fields/dictionaries on `public static class CoreAttrSchemas`. Each `AttrSchema` object becomes a `new AttrSchema(...)`. Maps become `Dictionary<string, IReadOnlyList<AttrSchema>>`.

- [ ] **Step 2: Verify build**

Run: `cd csharp && dotnet build MetaObjects/MetaObjects.csproj`
Expected: `Build succeeded`.

- [ ] **Step 3: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port core attribute schemas"
```

### Task 2.2: Port the core types provider

**Files:**
- Create: `csharp/MetaObjects/CoreTypes.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/CoreTypesTests.cs`

- [ ] **Step 1: Write the failing test** `CoreTypesTests.cs`

```csharp
using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class CoreTypesTests
{
    [Fact]
    public void Core_provider_registers_the_metamodel_vocabulary()
    {
        var reg = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        Assert.Equal("metaobjects-core-types", CoreTypes.CoreTypesProvider.Id);
        Assert.True(reg.Has("metadata", "root"));
        Assert.True(reg.Has("object", "entity"));
        Assert.True(reg.Has("field", "currency"));
        Assert.True(reg.Has("identity", "primary"));
        Assert.True(reg.Has("origin", "aggregate"));
        Assert.False(reg.Has("identity", "base")); // identity has NO base subtype
    }

    [Fact]
    public void Core_provider_factory_builds_the_right_node_class()
    {
        var reg = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var def = reg.Find("identity", "primary")!;
        var node = def.Factory(def.TypeId, "pk");
        Assert.IsType<MetaObjects.Meta.MetaPrimaryIdentity>(node);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter CoreTypesTests`
Expected: FAIL — `CoreTypes` does not exist.

- [ ] **Step 3: Implement `CoreTypes.cs`**

Port `core-types.ts`: the `wildcard` helper, `Def(...)` helper, `FIELD_DATA_TYPE` / `ATTR_DATA_TYPE` maps, `VALIDATOR_CLASS_MAP` / `IDENTITY_CLASS_MAP` / `ORIGIN_CLASS_MAP` (C#: `Dictionary<string, Func<TypeId, string, MetaData>>`), `registerCoreTypeDefs`, and `CoreTypesProvider` (a class implementing `IMetaDataTypeProvider` with `Id = "metaobjects-core-types"`).

**Scope note (Tier 3):** the TS `coreProviders` bundle also includes `dbProvider`. The conformance corpus loads fixtures with the provider id `"metaobjects-core-types"` **only** (no `providers.json` file exists in any fixture — verified). So this port ships **only** `CoreTypesProvider`. `dbProvider` is out of scope; do not port it. Undeclared `@name` attrs on `source` nodes (used by `source-db-*` fixtures) are accepted as untyped attrs by the parser — no provider needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter CoreTypesTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port core types provider"
```

---

## Slice 3 — JSON parser

Goal: parse a single canonical-JSON document into a typed tree (super resolution deferred — the loader does it).

### Task 3.1: Port the parser pipeline

**Files:**
- Create: `csharp/MetaObjects/Parser.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/ParserTests.cs`

- [ ] **Step 1: Write the failing test** `ParserTests.cs`

```csharp
using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ParserTests
{
    private static TypeRegistry Reg() => Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });

    [Fact]
    public void Parses_a_single_entity_with_a_field()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Widget", "children": [
                { "field.string": { "name": "title" } } ] } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(Reg()) { DeferSuperResolution = true });
        Assert.Empty(result.Errors);
        var widget = result.Root.OwnChildByName("Widget")!;
        Assert.Equal("object", widget.Type);
        Assert.Equal("entity", widget.SubType);
        Assert.Equal("title", widget.OwnChildren()[0].Name);
    }

    [Fact]
    public void Malformed_json_throws_ParseException_with_ERR_MALFORMED_JSON()
    {
        var ex = Assert.Throws<ParseException>(() =>
            Parser.ParseJson("{ not json", new ParseOptions(Reg())));
        Assert.Equal(ErrorCode.ERR_MALFORMED_JSON, ex.Code);
    }

    [Fact]
    public void Inline_attr_and_stringarray_desugar()
    {
        const string json = """
        { "metadata.root": { "children": [
            { "object.entity": { "name": "W", "children": [
                { "identity.primary": { "name": "pk", "@fields": "id" } } ] } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(Reg()) { DeferSuperResolution = true });
        var id = result.Root.OwnChildByName("W")!.OwnChildren()[0];
        Assert.Equal(new[] { "id" }, (IReadOnlyList<string>)id.OwnAttr("fields")!);
    }

    [Fact]
    public void Parser_handles_any_type_a_future_provider_registers()
    {
        // The parser holds no hardcoded type knowledge — a provider registering
        // a brand-new type is parsed with no parser change.
        var reg = Provider.ComposeRegistry(
            new IMetaDataTypeProvider[] { CoreTypes.CoreTypesProvider, new WidgetProvider() });
        const string json = """
        { "metadata.root": { "children": [ { "widget.fancy": { "name": "W" } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(reg) { DeferSuperResolution = true });
        Assert.Empty(result.Errors);
        Assert.Equal("widget", result.Root.OwnChildByName("W")!.Type);
    }
}

/// <summary>Test-only provider registering a type the core metamodel does not define.</summary>
file sealed class WidgetProvider : IMetaDataTypeProvider
{
    public string Id => "test-widget";
    public IReadOnlyList<string> Dependencies => new[] { "metaobjects-core-types" };
    public void RegisterTypes(TypeRegistry registry) => registry.Register(new TypeDefinition(
        new TypeId("widget", "fancy"), "test widget", new List<ChildRule>(),
        (id, name) => new MetaObjects.Meta.MetaObject(id, name), new List<AttrSchema>()));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter ParserTests`
Expected: FAIL — `Parser` / `ParseOptions` do not exist.

- [ ] **Step 3: Implement `Parser.cs`**

Port `parser-json.ts` + `parser-core.ts` into one file. Public surface:

```csharp
public sealed class ParseOptions(TypeRegistry registry)
{
    public TypeRegistry Registry { get; } = registry;
    public bool Strict { get; init; }
    public string? SourceName { get; init; }
    public MetaRoot? IntoRoot { get; init; }
    public bool DeferSuperResolution { get; init; }
}

public sealed record ParseResult(MetaRoot Root, IReadOnlyList<string> Warnings, IReadOnlyList<MetaError> Errors);

public static class Parser
{
    public static ParseResult ParseJson(string content, ParseOptions opts) { /* ... */ }
}
```

**Provider-driven invariant:** the parser must never branch on a concrete type name. Every type/subtype decision goes through `opts.Registry` — `Has`, `Find`, `AllSubTypesOf`, `AttrsOf`, `DefaultSubTypeOf`. The only metamodel strings the parser may reference are the structural reserved keys and separators in `Constants.cs` (`RESERVED_KEYS`, `ATTR_PREFIX`, `TYPE_SUBTYPE_SEPARATOR`, and `TYPE_ATTR` — the parser special-cases attr *child nodes* exactly as `parser-core.ts` does, and that is the one permitted type reference). This is what makes future providers work with no parser change — verified by `Parser_handles_any_type_a_future_provider_registers`.

Port the whole pipeline: `buildTree`, `splitTypeKey`, `defaultSubTypeFor`, `expandPackageForPath`, `parseNodeFresh`, `parseNodeInto`, `createOrFindMetaData`, `applyReservedKeys`, `normalizeStringArrayAttr`, `applyInlineAttrsAndUnknownKeys`, `processChildren`, `parseAttrChild`. C#-specific gotchas:
- **JSON parsing:** `System.Text.Json.JsonDocument.Parse`. Strip a leading UTF-8 BOM first. A `JsonException` → `throw new ParseException(msg, ErrorCode.ERR_MALFORMED_JSON, opts.SourceName)`.
- **Object model:** TS `Record<string, unknown>` → walk `JsonElement` with `JsonValueKind.Object`. Order of keys: `JsonElement.EnumerateObject()` preserves document order — good, the parser relies on children/attr order.
- **`_deferSuperResolution`:** TS uses a module-level flag. C# — pass `deferSuperResolution` as an explicit method parameter threaded through the recursion (cleaner; no shared mutable state). Tier 3.
- **`reportProblem`:** in strict mode throw `ParseException`; otherwise append to `warnings`. The collected `errors` list holds `MetaError` (convert from the TS `ParseError` pushes — each carries a `code`).
- **Top-level structural failures** (`ERR_TOP_LEVEL_NOT_OBJECT`, unknown root type) — `throw ParseException`, matching TS `buildTree`'s throw behavior.
- The `intoRoot` merge mode: when `opts.IntoRoot != null`, parse into it and return it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter ParserTests`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port registry-driven JSON parser pipeline"
```

---

## Slice 4 — Canonical serializer + Loader + conformance harness

Goal: `dotnet test` runs the whole corpus; happy-path fixtures needing only parse + multi-file merge + serialize pass; everything else is parked in the ledger.

### Task 4.1: Port the canonical serializer

**Files:**
- Create: `csharp/MetaObjects/SerializerJson.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/SerializerTests.cs`

- [ ] **Step 1: Write the failing test** `SerializerTests.cs`

```csharp
using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SerializerTests
{
    private static TypeRegistry Reg() => Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });

    [Fact]
    public void Canonical_output_round_trips_a_simple_tree_byte_for_byte()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Widget", "children": [
                { "field.string": { "name": "title" } } ] } } ] } }
        """;
        var result = Parser.ParseJson(json, new ParseOptions(Reg()) { DeferSuperResolution = true });
        var canonical = SerializerJson.CanonicalSerialize(result.Root);
        Assert.EndsWith("\n", canonical);
        Assert.Contains("\"metadata.root\"", canonical);
        Assert.Contains("\"field.string\"", canonical);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter SerializerTests`
Expected: FAIL — `SerializerJson` does not exist.

- [ ] **Step 3: Implement `SerializerJson.cs`**

Port `serializer-json.ts` (`serializeNode`, `serializeNodeInner`, `inferAttrSubType`, `fusedKey`, `canonicalSerialize`, `canonicalSerializeEffective`, `sortAttrKeys`). Build the output with `System.Text.Json.Nodes.JsonObject` / `JsonArray` (insertion order is preserved), then serialize.

**Byte-identical gotchas — these are Tier 1, get them exactly right:**
- **Indent:** 2 spaces. `new JsonSerializerOptions { WriteIndented = true }` — .NET 8 default indent is 2 spaces. Verify against a fixture; if .NET emits differently, set `IndentSize`/`IndentCharacter` (available .NET 9+) or hand-write with `Utf8JsonWriter`. On .NET 8, `WriteIndented = true` gives 2-space indent — confirm with the first fixture diff.
- **Escaping:** `JSON.stringify` does NOT escape `<`, `>`, `&`, `+`. .NET's default encoder DOES. Set `Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping`.
- **Trailing newline:** append exactly one `"\n"`.
- **Number formatting:** an integer attr is a C# `long` → emits `42`; a `double` that is integer-valued must match TS. TS `JSON.stringify(2)` is `2`, `JSON.stringify(2.5)` is `2.5`. Storing integers as `long` and non-integers as `double` (Task 1.2) makes this single-path. Watch `JsonValue.Create((double)2.0)` — it may emit `2`; that is correct only when the value is genuinely integral. Verify against `currency-*` fixtures.
- **Key order:** structural keys in canonical order, then `@`-attrs alphabetically, then `children` last — `sortAttrKeys` enforces this. Port it exactly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd csharp && dotnet test --filter SerializerTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port canonical JSON serializer"
```

### Task 4.2: Port the MetaDataSource abstraction + the loaders

The loader subsystem has three pieces, ported as one task: the `MetaDataSource` input abstraction, the core `MetaDataLoader` pipeline (`Load(IReadOnlyList<IMetaDataSource>)`), and the `FileMetaDataLoader` subclass that discovers file-backed sources.

**Files:**
- Create: `csharp/MetaObjects/Loader/MetaDataSource.cs`, `FileSource.cs`, `MetaDataLoader.cs`, `FileMetaDataLoader.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/LoaderTests.cs`

- [ ] **Step 1: Write the failing test** `LoaderTests.cs`

```csharp
using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class LoaderTests
{
    private static string Corpus =>
        System.IO.Path.GetFullPath(System.IO.Path.Combine(
            System.AppContext.BaseDirectory, "../../../../../fixtures/conformance"));

    [Fact]
    public void Core_loader_consumes_MetaDataSource_units()
    {
        // The base pipeline takes sources directly — no filesystem knowledge.
        var src = new InMemorySource(
            """{ "metadata.root": { "children": [
                 { "object.entity": { "name": "W" } } ] } }""",
            id: "inline.json");
        var result = new MetaDataLoader().Load(new IMetaDataSource[] { src });
        Assert.Empty(result.Errors);
        Assert.NotNull(result.Root.OwnChildByName("W"));
    }

    [Fact]
    public void FileMetaDataLoader_discovers_and_merges_a_directory()
    {
        var loader = new FileMetaDataLoader();
        var result = loader.LoadDirectory(
            System.IO.Path.Combine(Corpus, "loader-basic-single-entity", "input"));
        Assert.Empty(result.Errors);
        Assert.Equal("loaded", loader.State);
    }
}
```

(If the relative `../` depth to the corpus is wrong from the test `bin/` dir, fix the path — Task 4.3 centralizes corpus discovery; reuse `CorpusRoot.Path` once it exists.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter LoaderTests`
Expected: FAIL — `IMetaDataSource` / `MetaDataLoader` / `FileMetaDataLoader` do not exist.

- [ ] **Step 3: Implement `MetaDataSource.cs`**

Port `loader/meta-data-source.ts`. Tier 2: the C# loader is synchronous (corpus is tiny; sync I/O keeps the adapter simple), so `Read()` returns `string`, not a task.

```csharp
namespace MetaObjects.Loader;

/// <summary>Content format of a source — selects the parser.</summary>
public enum MetaDataFormat { Json, Yaml }

/// <summary>One unit of raw metadata input consumed by the loader pipeline.</summary>
public interface IMetaDataSource
{
    /// <summary>Human-readable id — used in parse-error messages (e.g. a filename).</summary>
    string Id { get; }
    /// <summary>Content-format hint — selects the parser.</summary>
    MetaDataFormat Format { get; }
    /// <summary>Resolve the raw content. May perform I/O.</summary>
    string Read();
}

/// <summary>A metadata source backed by an in-memory string.</summary>
public sealed class InMemorySource(string content, string id = "<in-memory>",
    MetaDataFormat format = MetaDataFormat.Json) : IMetaDataSource
{
    public string Id => id;
    public MetaDataFormat Format => format;
    public string Read() => content;
}
```

- [ ] **Step 4: Implement `FileSource.cs`**

Port `core/file-source.ts`. `FileSource` implements `IMetaDataSource`: `Id` is `Path.GetFileName(path)`, `Format` inferred from extension (`.yaml`/`.yml` → `Yaml`, else `Json`), `Read()` does `File.ReadAllText(path)` (strip BOM in the parser, not here). Expose the full `Path` via a property.

- [ ] **Step 5: Implement `MetaDataLoader.cs` — the core pipeline**

Port `loader/meta-data-loader.ts`. The core method is `LoadResult Load(IReadOnlyList<IMetaDataSource> sources)` — it holds **no** filesystem knowledge. Port exactly:
- `LoadResult` record: `(MetaRoot Root, IReadOnlyList<string> Warnings, IReadOnlyList<MetaError> Errors)`.
- `LoadingState` — `"uninitialized" | "loading" | "loaded" | "error"` (string property `State`).
- One-shot guard: a second `Load` after completion throws.
- The merge loop: for each source, `Read()` (catch I/O failure → collect `MetaError`), then `ParseSource(content, source, parseOpts)` — first source creates the root, subsequent sources parse with `IntoRoot = root`. **All sources parse with `DeferSuperResolution = true`.** Catch `ParseException` per source → collect as `MetaError` (carry `.Code`).
- `ParseSource` is a `protected virtual` seam (mirrors the TS override seam): the base implementation handles `MetaDataFormat.Json` via `Parser.ParseJson` and throws for any other format. `FileMetaDataLoader` does **not** need to override it (corpus is JSON-only); the seam exists so a future YAML port slots in.
- Validation passes run **after** the merge loop, in this exact order (Slices 5–6 implement them; for now leave each call commented with a `// Slice N:` marker):
  1. `resolveDeferredSupers` (Slice 5)
  2. `validateSubtypeRules` (Slice 6)
  3. `validateDataGridSortFields` (Slice 6)
  4. `validateFilterableHasIndex` (Slice 6)
  5. `validateOriginPaths` (Slice 6)
  6. `validateAttrSchema` (Slice 6)
- Synthetic empty root when all sources fail; `Freeze()` the root before returning; set `State`.
- Constructor takes an optional `TypeRegistry`; the default builds it via `Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider })`.

- [ ] **Step 6: Implement `FileMetaDataLoader.cs`**

Port `core/file-meta-data-loader.ts`. `FileMetaDataLoader : MetaDataLoader` adds source *discovery* only — it builds `FileSource` units and delegates to the base `Load`. It exposes the **same optional-`TypeRegistry` constructor** as the base and forwards it via `base(registry)` — the conformance adapter composes a per-fixture registry from that fixture's declared providers and passes it in. Methods:
- `LoadResult LoadFiles(IReadOnlyList<string> paths)` → `Load(paths.Select(p => new FileSource(p)).ToList())`.
- `LoadResult LoadDirectory(string dir)` → list directory entries, keep `.json`/`.yaml`/`.yml`, **sort ordinal by filename** (deterministic multi-file order — overlay merge is order-sensitive), build `FileSource`s, call `Load`. A directory-read failure surfaces as a collected `MetaError` (mirror the TS empty-source path).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd csharp && dotnet test --filter LoaderTests`
Expected: PASS — 2 tests green.

- [ ] **Step 8: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port MetaDataSource + MetaDataLoader/FileMetaDataLoader pipeline"
```

### Task 4.3: Build the conformance harness + expected-failures ledger

This task ports the *full* TS conformance engine surface — not a subset. The TS runner does **two** tests per fixture: a `lint:` test (corpus integrity, adapter-independent) and a `conformance:` test (the port's behavior). Both are ported. It also supports `expected-effective.json` and per-fixture `providers.json`; both are ported even though no current fixture uses them, so a future fixture works with no harness change.

**Files:**
- Create: `csharp/MetaObjects.Conformance.Tests/CorpusRoot.cs`, `FixtureDiscovery.cs`, `OperationScript.cs`, `FixtureLint.cs`, `ConformanceAdapter.cs`, `ExpectedFailures.cs`, `conformance-expected-failures.json`, `ConformanceTests.cs`
- Modify: `csharp/MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj` (copy the ledger to output)

- [ ] **Step 1: Implement `CorpusRoot.cs`**

A single `static class CorpusRoot { public static string Path { get; } }` that resolves the corpus once: honor the `METAOBJECTS_CONFORMANCE_CORPUS` env var (mirrors the TS runner's override), else walk up from `AppContext.BaseDirectory` until a directory containing `fixtures/conformance` is found. Every test reuses this — no scattered `../../..` paths.

- [ ] **Step 2: Implement `FixtureDiscovery.cs`**

Port `typescript/packages/conformance/src/fixture.ts` in full. `Fixture` record: `Name`, `Dir`, `InputDir`, `Providers` (`IReadOnlyList<string>`), `HasExpected`, `HasExpectedEffective`, `HasExpectedErrors`, `HasExpectedWarnings`, `HasScript`. `DiscoverFixtures(corpusRoot)` returns them sorted by name; throws if a fixture has no `input/` dir. **Port the `providers.json` read** — when a fixture has `providers.json` (a JSON array of strings) use it; otherwise default to `["metaobjects-core-types"]`. (No current fixture has one — verified — but the discovery must honor it for parity.)

- [ ] **Step 3: Implement `OperationScript.cs`**

Port `typescript/packages/conformance/src/operation-script.ts` in full: `ParseExpectedErrors(JsonElement) → IReadOnlyList<string>` (validates `expected-errors.json` is an array of `{code: string}` objects; returns the codes — throws a clear exception on malformed input) **and** `ParseOperationScript(JsonElement) → OperationScript` (the `script.json` schema: `Operation` = `Navigate[]`, `Invoke`, `Args?`, `Expect`). Both parsers are needed now: `ParseExpectedErrors` is used by the runner (error fixtures are checked from this slice on) and by lint; `ParseOperationScript` is used by lint now and by the Slice 7 script runner. The `expected-errors.json` format is a JSON array of `{ "code": "ERR_..." }` objects (confirmed against the corpus).

- [ ] **Step 4: Implement `FixtureLint.cs`**

Port `typescript/packages/conformance/src/fixture-lint.ts` in full. `LintFixture(Fixture, IReadOnlyList<string> errorCodes) → IReadOnlyList<string>` (problem strings; empty = clean): every `expected-errors.json` code must be a registered code; `script.json` must parse; each navigate colon-segment must name a node present in `expected.json` (the `namesIn` recursive collector), bracket-segments accepted as-is. `errorCodes` is the key set of the corpus's `ERROR-CODES.json` — load it from `CorpusRoot.Path`.

- [ ] **Step 5: Implement `ConformanceAdapter.cs`**

Port the contract of `conformance/src/adapter.ts` + `test/conformance/adapter.ts`.

```csharp
public sealed record LoadOutcome(
    MetaRoot Tree, IReadOnlyList<string> ErrorCodes, IReadOnlyList<string> Warnings);

public static class ConformanceAdapter
{
    /// <summary>Provider-id → provider. The fixture corpus names providers by stable id;
    /// this maps them to provider objects. An unknown id throws (parity with the TS adapter).</summary>
    private static readonly IReadOnlyDictionary<string, IMetaDataTypeProvider> Providers =
        new Dictionary<string, IMetaDataTypeProvider>
        { ["metaobjects-core-types"] = CoreTypes.CoreTypesProvider };

    public static LoadOutcome LoadFixture(string inputDir, IReadOnlyList<string> providers)
    {
        var resolved = providers.Select(id => Providers.TryGetValue(id, out var p)
            ? p : throw new System.ArgumentException($"Unknown provider id \"{id}\"")).ToList();
        var registry = Provider.ComposeRegistry(resolved);
        var result = new MetaObjects.Loader.FileMetaDataLoader(registry).LoadDirectory(inputDir);
        return new LoadOutcome(result.Root,
            result.Errors.Select(e => e.Code.ToString()).ToList(), result.Warnings);
    }

    public static string CanonicalSerialize(MetaRoot tree) => SerializerJson.CanonicalSerialize(tree);
    public static string CanonicalSerializeEffective(MetaRoot tree)
        => SerializerJson.CanonicalSerializeEffective(tree);
}
```

The `FileMetaDataLoader` needs a constructor taking a `TypeRegistry` (the registry is composed per-fixture from its declared providers — not the loader's built-in default). Confirm Task 4.2 Step 5/6 gave both loaders an optional-registry constructor; if not, add it. `Navigate` / `Invoke` (the capability script) are added in Slice 7 — leave a `// Slice 7` marker.

- [ ] **Step 6: Implement `ExpectedFailures.cs` + seed the ledger empirically**

Port `conformance/src/expected-failures.ts`: `Classify(bool passed, string name) → string` — listed + fail → `"known-gap"`; listed + pass → `"fixed-but-listed"`; unlisted + fail → `"fail"`; unlisted + pass → `"pass"`. `LoadLedger(path)` — missing file = empty ledger.

**Seed the ledger empirically — do NOT guess.** Create `conformance-expected-failures.json` as `{ "language": "csharp", "fixtures": [] }`, run the suite (Step 8), then add to `fixtures` *exactly* the fixtures that actually fail. Predicting the set by hand is unreliable — e.g. `error-parse-malformed-json` and `error-unknown-relationship-subtype` are parse-time errors that already pass at Slice 4, so listing them would wrongly trip `fixed-but-listed`. As a *cross-check only*, the Slice-4 failing set should be ~13 fixtures: the four `extends-*`, `error-extends-nonexistent`, the six validation-dependent `error-*` (`error-attr-bad-allowed-value`, `error-attr-missing-required`, `error-attr-wrong-type`, `error-data-grid-bad-sort-field`, `error-origin-bad-aggregate-fn`, `error-origin-bad-via-path`), `subtype-entity-missing-primary-warning`, and `warning-filterable-no-index`. If your observed set differs, trust the observed set and investigate any surprise before listing it.

Mark the csproj to copy the ledger to output: `<None Include="conformance-expected-failures.json"><CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory></None>`. Likewise ensure tests can read the corpus (they read it live from `CorpusRoot.Path` — no copy needed).

**Discipline (cross-language-porting skill):** the ledger records honestly what is not done. Later slices *shrink* it. Never add a fixture to silence a real regression; never regenerate a golden to turn a check green.

- [ ] **Step 7: Implement `ConformanceTests.cs` — two [Theory] tests**

Port `typescript/packages/metadata/test/conformance.test.ts` + `conformance/src/runner.ts`. Two theories over the same discovered fixtures:

```csharp
public class ConformanceTests
{
    public static IEnumerable<object[]> Fixtures() =>
        FixtureDiscovery.DiscoverFixtures(CorpusRoot.Path).Select(f => new object[] { f });

    private static readonly string[] ErrorCodes = /* keys of CorpusRoot ERROR-CODES.json */;

    [Theory, MemberData(nameof(Fixtures))]
    public void Lint(Fixture fix)
        => Assert.Empty(FixtureLint.LintFixture(fix, ErrorCodes));

    [Theory, MemberData(nameof(Fixtures))]
    public void Conformance(Fixture fix)
    {
        var outcome = ConformanceAdapter.LoadFixture(fix.InputDir, fix.Providers);
        bool passed = RunChecks(fix, outcome, out string detail);
        var status = ExpectedFailures.Classify(passed, fix.Name);
        Assert.True(status is "pass" or "known-gap", $"{fix.Name} [{status}]: {detail}");
    }
}
```

`RunChecks` mirrors `runner.ts` exactly — run every check the fixture declares:
- `HasExpectedErrors` → compare `outcome.ErrorCodes` to `ParseExpectedErrors(expected-errors.json)`, both sorted.
- `HasExpected` → assert `outcome.ErrorCodes` empty; `CanonicalSerialize` the tree; compare **trimmed, exact** to `expected.json`.
- `HasExpectedEffective` → `CanonicalSerializeEffective`; compare trimmed-exact to `expected-effective.json`.
- `HasExpectedWarnings` → compare `outcome.Warnings` to `expected-warnings.json`, both sorted; if absent on a happy-path fixture, assert `outcome.Warnings` empty.
- `HasScript` → Slice 7 (leave a `// Slice 7` marker; until then a script-only check is skipped, which is why `extends-abstract-base` stays ledgered through Slice 6).
- A fixture declaring no expectation file at all → a failed check (configuration error), matching `runner.ts`.

- [ ] **Step 8: Run the full corpus, then finalize the ledger**

Run: `cd csharp && dotnet test`
First run: every `Lint` test must pass (clean corpus); `Conformance` tests fail for unhandled fixtures. Add the **observed** failing set to `conformance-expected-failures.json` (Step 6). Re-run: expected ALL green — passing fixtures `pass`, ledgered fixtures `known-gap`, nothing `fail` or `fixed-but-listed`. If a fixture you expected to pass fails on a canonical diff, fix the serializer/parser — **never edit the fixture**; if you suspect a stale golden, stop and escalate.

- [ ] **Step 9: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): conformance harness (lint + conformance) + ledger; happy-path fixtures green"
```

---

## Slice 5 — Super (`extends`) resolution

Goal: `extends-*` fixtures and `error-extends-nonexistent` pass; removed from the ledger.

### Task 5.1: Port super resolution

**Files:**
- Create: `csharp/MetaObjects/SuperResolve.cs`
- Modify: `csharp/MetaObjects/Loader/MetaDataLoader.cs` (wire in pass 1)
- Modify: `csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`
- Test: `csharp/MetaObjects.Conformance.Tests/SuperResolveTests.cs`

- [ ] **Step 1: Write the failing test** `SuperResolveTests.cs`

```csharp
using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SuperResolveTests
{
    [Fact]
    public void Single_level_extends_resolves_and_inherits_fields()
    {
        var result = new FileMetaDataLoader().LoadDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, "extends-single-level", "input"));
        Assert.Empty(result.Errors);
        // the subtype's effective fields include the base's fields
        var sub = result.Root.OwnChildren().First(c => c.SuperData != null);
        Assert.True(sub.Children().Count > sub.OwnChildren().Count);
    }

    [Fact]
    public void Nonexistent_extends_collects_ERR_UNRESOLVED_SUPER()
    {
        var result = new FileMetaDataLoader().LoadDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, "error-extends-nonexistent", "input"));
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNRESOLVED_SUPER);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter SuperResolveTests`
Expected: FAIL — `SuperResolve` / deferred resolution not wired.

- [ ] **Step 3: Implement `SuperResolve.cs`**

Port `super-resolve.ts`: `findInTree`, `resolveSuperRef` (absolute `::`, relative `..::`, bare/same-package), `resolveDeferredSupers` (walk with context-package tracking, collect `DeferredSuperFailure`), `walk`. `DeferredSuperFailure` is a record `(string NodeFqn, string Ref)`.

- [ ] **Step 4: Wire pass 1 into the loader**

In `MetaDataLoader.Load`, after the merge loop, replace the `// Slice 5` marker with: call `SuperResolve.ResolveDeferredSupers(root)`; for each failure add `new MetaError($"the SuperClass '{failure.Ref}' does not exist (referenced by {failure.NodeFqn})", ErrorCode.ERR_UNRESOLVED_SUPER)`.

- [ ] **Step 5: Shrink the ledger to the observed failing set**

Re-run `dotnet test` and remove from `conformance-expected-failures.json` every fixture that now passes — the ledger must end as *exactly* the still-failing set. Expected outcome: the four `extends-*` fixtures and `error-extends-nonexistent` come off; `extends-abstract-base` stays (its `script.json` check is not implemented until Slice 7). If the observed set differs, trust the run and investigate the surprise before editing the ledger.

- [ ] **Step 6: Run the full corpus**

Run: `cd csharp && dotnet test`
Expected: PASS — `SuperResolveTests` green; the four removed fixtures now pass unlisted; nothing classified `fixed-but-listed`. If `extends-abstract-base`'s non-script checks now pass, leave it listed (the script check still fails until Slice 7) — confirm it stays `known-gap`.

- [ ] **Step 7: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port super (extends) resolution; extends-* fixtures green"
```

---

## Slice 6 — Validation passes

Goal: every `error-*` and `warning-*`/`subtype-*-warning` fixture passes; removed from the ledger.

### Task 6.1: Port subtype rules + the loader validation passes

**Files:**
- Create: `csharp/MetaObjects/Loader/ValidationPasses.cs`
- Test: `csharp/MetaObjects.Conformance.Tests/ValidationTests.cs`

- [ ] **Step 1: Write the failing test** `ValidationTests.cs`

```csharp
using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ValidationTests
{
    private static LoadResult Load(string fixture) =>
        new FileMetaDataLoader().LoadDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, fixture, "input"));

    [Fact]
    public void Bad_default_sort_field_is_an_error()
        => Assert.Contains(Load("error-data-grid-bad-sort-field").Errors,
            e => e.Code == ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD);

    [Fact]
    public void Filterable_without_index_is_a_warning()
        => Assert.NotEmpty(Load("warning-filterable-no-index").Warnings);

    [Fact]
    public void Bad_via_path_is_an_origin_error()
        => Assert.Contains(Load("error-origin-bad-via-path").Errors,
            e => e.Code == ErrorCode.ERR_INVALID_ORIGIN);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd csharp && dotnet test --filter ValidationTests`
Expected: FAIL — validation passes not implemented.

- [ ] **Step 3: Implement `ValidationPasses.cs`**

Port three TS files into this one file:
- `loader/validation-passes.ts` — `ValidateDataGridSortFields` (→ `ERR_BAD_DEFAULT_SORT_FIELD`), `ValidateFilterableHasIndex` (→ warnings), `ValidateOriginPaths` (→ `ERR_INVALID_ORIGIN`), plus the private helpers `_findObject`/`_findField`/`_findRelationship`/`_validateFromPath`/`_validateViaPath`.
- `subtype-rules.ts` — `ValidateSubtypeRules` (entity-should-have-primary-identity → warning; value-must-not-have-identity → `ERR_SUBTYPE_RULE_VIOLATION`). Read the TS file for the exact returned `{ errors, warnings }` shape.
- `attr-schema-validate.ts` — `ValidateAttrSchema(root, registry)`. Three checks, all errors (no warnings): required attrs present — uses **effective** `Attrs()` so an inherited required attr counts (`ERR_MISSING_REQUIRED_ATTR`); declared attrs on the node well-typed — uses **own** `OwnAttrs()` (`ERR_BAD_ATTR_VALUE`); `allowedValues` membership (`ERR_BAD_ATTR_VALUE`). **Undeclared attrs are NOT flagged** — open policy, no error and no warning. `ERR_UNKNOWN_ATTR` is *not* emitted by this pass; it comes only from the parser (a non-`@`-prefixed unknown structural key). Port the exact own-vs-effective split and the `valueMatchesType` numeric/string/boolean/stringarray logic from the TS file.

Each pass is a pure static method on `static class ValidationPasses` returning `IReadOnlyList<MetaError>` or `(errors, warnings)`.

- [ ] **Step 4: Wire passes 2–6 into the loader**

In `MetaDataLoader.Load`, replace the `// Slice 6` markers with calls in this exact order: `ValidateSubtypeRules`, `ValidateDataGridSortFields`, `ValidateFilterableHasIndex`, `ValidateOriginPaths`, `ValidateAttrSchema`. Append their errors to `errors` and warnings to `warnings`.

- [ ] **Step 5: Shrink the ledger to the observed failing set**

Re-run `dotnet test` and remove from `conformance-expected-failures.json` every fixture that now passes. Expected outcome: every remaining `error-*` fixture, `warning-filterable-no-index`, and `subtype-entity-missing-primary-warning` come off — leaving **only `extends-abstract-base`** (its `script.json` check awaits Slice 7). If the observed set differs, trust the run; a fixture failing on a wrong error code or message-set means the validation port is wrong — fix it, do not edit the fixture or the ledger.

- [ ] **Step 6: Run the full corpus**

Run: `cd csharp && dotnet test`
Expected: PASS — `ValidationTests` green; all `error-*`/`warning-*` fixtures pass unlisted. If any fails: the validator's error code or message-set is wrong — diff against `expected-errors.json` and fix the port. **Do not edit the fixture.** If you genuinely suspect a fixture is a stale golden, stop and escalate (per the cross-language-porting skill — you are the translator, not the alignment authority).

- [ ] **Step 7: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port validation passes; error-* and warning-* fixtures green"
```

---

## Slice 7 — Capability script (navigate + invoke)

Goal: `extends-abstract-base` (the only fixture with a `script.json`) passes; the ledger is empty.

### Task 7.1: Port the operation-script support

**Files:**
- Create: `csharp/MetaObjects.Conformance.Tests/Result.cs`, `Navigator.cs`, `CapabilityBinding.cs`
- Modify: `csharp/MetaObjects.Conformance.Tests/ConformanceAdapter.cs`, `ConformanceTests.cs` (`RunChecks` runs script ops), `conformance-expected-failures.json`
- Test: covered by the `extends-abstract-base` conformance fixture itself.

`OperationScript.cs` (the `script.json` / `expected-errors.json` parsers) already exists — it was ported in Task 4.3 Step 3. This task adds only the *execution* side.

- [ ] **Step 1: Inspect the inputs**

Read `fixtures/conformance/extends-abstract-base/script.json` and `typescript/packages/conformance/src/result.ts` + `test/conformance/navigator.ts` + `binding.ts` to learn the `NormalizedResult` comparison and the navigate/invoke contract.

- [ ] **Step 2: Implement `Result.cs`**

Port `conformance/src/result.ts`: the `NormalizedResult` vocabulary and `ResultsEqual`. The closed set of shapes is `{names: string[]}`, `{name: string}`, `{absent: true}`, `{scalar: string|long|double|bool|null}`, `{subtype: string}`, `{"effective-tree": string}`, `{error: {code: string}}`. Model it as a `record` hierarchy or a tagged struct; port `ResultsEqual` exactly — note error equality is **by `code` only**, and `names` equality is order-sensitive element-wise.

- [ ] **Step 3: Implement `Navigator.cs`**

Port `test/conformance/navigator.ts`: a path segment is `type:name` or `type[subType]`; walk `Children()` matching each segment; empty path returns root.

- [ ] **Step 4: Implement `CapabilityBinding.cs`**

Port `test/conformance/binding.ts`: the capability-id → function table. Capabilities (from `fixtures/conformance/CAPABILITIES.json` + `binding.ts`): `object.effective-fields`, `object.own-fields`, `object.find-field`, `object.primary-identity`, `field.effective-validators`, `field.is-required`, `field.max-length`, `field.effective-tree`. Each maps a node + args to a `NormalizedResult`. An unbound id → throw `UnknownCapabilityException` (port `UnknownCapabilityError`).

- [ ] **Step 5: Wire script checks into the harness**

Extend `ConformanceAdapter` with `Navigate(tree, path)` and `Invoke(node, capabilityId, args)`. In `ConformanceTests.RunChecks`, when `fix.HasScript`: parse `script.json`, for each operation navigate + invoke + compare to `expect` via `resultsEqual`.

- [ ] **Step 6: Empty the ledger**

Remove `extends-abstract-base` from `conformance-expected-failures.json` — it becomes `{ "language": "csharp", "fixtures": [] }`.

- [ ] **Step 7: Run the full corpus**

Run: `cd csharp && dotnet test`
Expected: PASS — **every fixture green, ledger empty**, nothing `known-gap` or `fixed-but-listed`.

- [ ] **Step 8: Final verification — count parity with TS**

Run: `cd typescript && bun test packages/metadata/test/conformance.test.ts` and `cd csharp && dotnet test`. Confirm both runners enumerate the same fixture count and both are fully green.

- [ ] **Step 9: Commit**

```bash
git add -A csharp && git commit -m "feat(csharp): port capability script support; full conformance corpus green"
```

### Task 7.2: Update the C# README + roadmap

**Files:**
- Modify: `csharp/README.md`, `spec/roadmap.md`

- [ ] **Step 1: Rewrite `csharp/README.md`**

Replace the "Planned" stub with: what the C# port covers (Loader + canonical serializer + conformance runner), how to run it (`cd csharp && dotnet test`), and the conformance-corpus-as-oracle principle. Note what is out of scope (codegen, runtime, `dbProvider`).

- [ ] **Step 2: Update `spec/roadmap.md`**

Move the C# port from "Future (sketched)" into a completed/active line, mirroring how the Java port (H3) is described.

- [ ] **Step 3: Commit**

```bash
git add -A csharp spec/roadmap.md && git commit -m "docs(csharp): document the C# conformance port"
```

---

## Self-Review

**Spec coverage:** Every pipeline stage of the TS reference has a slice — constants/errors/registry (Slice 0), value model + tree (Slice 1), provider (Slice 2), parser (Slice 3), serializer + loader + harness (Slice 4), super resolution (Slice 5), validation passes (Slice 6), capability script (Slice 7). All ~42 corpus fixtures are accounted for: happy-path → Slice 4, `extends-*` → Slice 5, `error-*`/`warning-*` → Slice 6, the lone `script.json` fixture → Slice 7.

**Placeholder scan:** "port `<file>.ts`" instructions are not placeholders — for a cross-language port the named TS file is the authoritative spec, and the porting skill explicitly requires reading reference implementations rather than re-deriving from prose. Every such instruction names an exact file, the exact C# surface, the C#-specific gotchas, and a concrete fixture-or-unit-test verification.

**Type consistency:** `MetaError` (record, carries `ErrorCode Code`) is used uniformly from Slice 0 onward. `ParseOptions`/`ParseResult`/`LoadResult` signatures defined in Slices 3–4 are reused unchanged in Slices 5–6. `AttrValue` = `object?` constrained to `{string,long,double,bool,IReadOnlyList<string>}` is fixed in Task 1.2 and relied on by the serializer (Task 4.1). Node constructors are uniformly `(TypeId, string)` so `TypeDefinition.Factory` binds. The validation-pass method names in Task 4.2 Step 5's commented markers (`ValidateSubtypeRules`, `ValidateDataGridSortFields`, `ValidateFilterableHasIndex`, `ValidateOriginPaths`, `ValidateAttrSchema`) match the implementations in Task 6.1. The loader subsystem (Task 4.2) splits into the `IMetaDataSource` abstraction, the source-driven core `MetaDataLoader.Load`, and the discovery-only `FileMetaDataLoader` — the conformance adapter (Task 4.3) and all Slice 5–6 tests use `FileMetaDataLoader`.

**Risk to watch during execution:** byte-identical serialization (Task 4.1) — .NET's JSON encoder escapes and indents differently from `JSON.stringify`. The first happy-path fixture diff will expose any mismatch; the gotchas list (`UnsafeRelaxedJsonEscaping`, 2-space indent, trailing newline, long-vs-double numbers) covers the known traps. If a fixture diff is whitespace-only, fix the serializer options, never the fixture.

---

## Audit trail — cross-check against TS + Java

This plan was reviewed against the full TS reference pipeline and the Java H3a port. Findings:

**Java port (H3a) — used only to corroborate architecture, never as the behavior oracle.** Java confirms the `MetaDataSource` / `MetaDataLoader.load(List<MetaDataSource>)` / `FileMetaDataLoader`-discovery layering this plan adopts. But Java is *behind* the TS reference: it has **not** ported the validation passes (it uses a constraint framework instead), the canonical serializer, or a conformance harness. So for validation, serialization, and conformance this plan follows **TS exclusively** — Java is not evidence there. (Minor naming/format divergences in Java — `InMemoryMetaDataSource`, a `JSON|XML` format enum — are Tier 2; the plan follows TS naming and the `Json|Yaml` enum.)

**Shortcuts found in the first draft and corrected:**
1. **Ledger seeding was prescriptive guessing** — it listed `error-parse-malformed-json` and `error-unknown-relationship-subtype`, which are parse-time errors that pass as early as Slice 4; listing them would trip `fixed-but-listed`. Fixed: the ledger is now seeded and shrunk **empirically** from observed runs (Tasks 4.3 / 5.1 / 6.1).
2. **`lintFixture` was dropped** — the TS runner does a `lint:` test per fixture (corpus integrity). Fixed: `FixtureLint.cs` is ported and run as its own `[Theory]` (Task 4.3 Steps 4, 7).
3. **`expected-effective.json` support was dropped** — no current fixture uses it, but the TS runner supports it. Fixed: `HasExpectedEffective` + a `CanonicalSerializeEffective` check branch are ported (Task 4.3 Steps 2, 7).
4. **Per-fixture `providers.json` was dropped** — the adapter hardcoded the core provider. Fixed: discovery reads `providers.json`, the adapter maps ids→providers and composes a per-fixture registry, unknown id throws (Task 4.3 Steps 2, 5).
5. **Parser/ordering of `parseExpectedErrors`** — error fixtures are checked from Slice 4, but the operation-script parsers were slated for Slice 7. Fixed: `OperationScript.cs` (both `ParseExpectedErrors` and `ParseOperationScript`) is ported in Slice 4 (Task 4.3 Step 3); Slice 7 adds only the execution side (`Result.cs`, `Navigator.cs`, `CapabilityBinding.cs`).

**Confirmed correct (no shortcut):** `validateAttrSchema` does not emit `ERR_UNKNOWN_ATTR` — undeclared attrs are open-policy; the plan now states this explicitly (Task 6.1). All six loader passes (super resolution + five validators) are present and ordered as in `meta-data-loader.ts`. `dbProvider` is genuinely unneeded — every fixture loads with `metaobjects-core-types` only.

**One deliberate divergence from the current TS runner — flagged, not silent.** The TS conformance runner/adapter (`conformance/src/runner.ts`, `adapter.ts`) has **no warnings handling at all** — its `LoadOutcome` carries only `{tree, errorCodes}`. Yet the corpus ships `expected-warnings.json` for `warning-filterable-no-index` and `subtype-entity-missing-primary-warning`, and the corpus spec (`spec/conformance-tests.md`) explicitly mandates comparing warnings. Under the TS runner those two fixtures pass on the `expected.json` canonical match alone; their warnings are unverified. **This C# plan checks warnings** (`LoadOutcome.Warnings`, the `HasExpectedWarnings` branch in `RunChecks`) — following the corpus *spec*, not the lagging TS runner. The `expected-warnings.json` content is real TS-loader output (the corpus was extracted from TS tests), so a correct C# port matches it. Consequence: the two warning fixtures genuinely require Slice 6 (subtype-rules / filterable passes) and are correctly ledgered until then. **TS-side follow-up:** the TS runner should be brought up to its own spec — raise this with the maintainer; do not "fix" it by weakening the C# runner.
