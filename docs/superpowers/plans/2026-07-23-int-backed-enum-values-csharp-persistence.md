# Int-Backed Enum Values — C# Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `field.enum`'s `@intValueMap` (metamodel layer already shipped) into C#'s EF Core codegen: emit a custom `HasConversion` lambda pair built from `@intValueMap`'s lookup table instead of the blanket `HasConversion<string>()`, while the generated C# `enum` type itself is completely unchanged. C# never generates DDL (schema is TS-owned per ADR-0015) — this plan touches `DbContextGenerator.cs` only.

**Architecture:** `DbContextGenerator.EmitFieldTypeConfig`'s existing `foreach (var f in fieldList.Where(f => f.SubType == FIELD_SUBTYPE_ENUM))` loop (the one that unconditionally emits `HasConversion<string>()`) gets a conditional: when `f.Attr("intValueMap")` is present, emit a custom `.HasConversion(v => ..., v => ...)` pair instead — the exact inline-lambda shorthand this file already uses for `field.uri` (`.HasConversion(v => v!.ToString(), v => new System.Uri(v))`), just driven by a generated `Dictionary<string,int>` literal rather than a fixed conversion. `EntityGenerator.CollectEnumDecls` (the C# `enum` type emitter) is **not touched at all** — confirmed no port's enum-type emitter reads `@intValueMap`, so the generated `enum Status { DRAFT, PUBLISHED, ARCHIVED }` declaration is byte-identical whether or not the field is int-backed. No `ValueConverter<TModel,TProvider>` class exists anywhere in this codebase today (confirmed via full-repo grep) — this plan introduces the inline-lambda form only, matching the file's own established idiom, not the standalone-class form.

**Tech Stack:** C#, .NET, EF Core 8, xunit.

## Global Constraints

- The generated C# `enum` type is byte-identical between string- and int-backed fields — do not touch `EntityGenerator.CollectEnumDecls` or `EnumPropertyTypeName`.
- C# generates NO DDL. If a step here tempts you to write SQL/CHECK-constraint code, stop — that's TS's job (already done in the TS persistence plan).
- `@intValueMap`'s presence alone is the trigger — mirror the existing `HasConversion<string>()` loop's unconditional style, just branching on attribute presence.
- Apply the identical conditional to BOTH loops that emit enum conversions today: the base/write-entity loop (`DbContextGenerator.cs` research lines 353-363) and the projection/read-model loop (lines 67-68).

---

### Task 1: `FieldConstants.FIELD_ATTR_INT_VALUE_MAP` reader helper

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs`
- Test: `server/csharp/MetaObjects.Codegen.Tests/EnumIntValueMapConversionTests.cs`

**Interfaces:**
- Consumes: `FieldConstants.FIELD_ATTR_INT_VALUE_MAP` (metamodel plan, already shipped — the constant lives in `server/csharp/MetaObjects/Core/Field/FieldConstants.cs`).
- Produces: a private static helper `TryGetIntValueMap(MetaField f, out IReadOnlyDictionary<string, long>? map)` consumed by Tasks 2-3.

- [ ] **Step 1: Write the failing test**

```csharp
// server/csharp/MetaObjects.Codegen.Tests/EnumIntValueMapConversionTests.cs
using Xunit;
using MetaObjects.Loader;
using MetaObjects.Codegen.Generators;

namespace MetaObjects.Codegen.Tests;

public class EnumIntValueMapConversionTests
{
    private static MetaRoot LoadModel(string json)
    {
        var loader = new MetaDataLoader();
        var r = loader.Load(new[] { (IMetaDataSource)new InMemoryStringSource(json, "test.json") });
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private const string Model = """
    { "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Int_backed_enum_emits_a_custom_HasConversion_lambda_pair_not_HasConversion_string()
    {
        var root = LoadModel(Model);
        var output = new DbContextGenerator().Generate(new GenContext { Entities = new[] { root.FindObject("Order")! } });
        var contents = output.Single(f => f.Path.EndsWith("AppDbContext.g.cs")).Contents;
        Assert.DoesNotContain("Property(x => x.Status).HasConversion<string>()", contents);
        Assert.Contains(".Property(x => x.Status).HasConversion(", contents);
    }

    [Fact]
    public void String_backed_enum_still_emits_HasConversion_string_unchanged()
    {
        var root = LoadModel("""
        { "metadata.root": { "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """);
        var output = new DbContextGenerator().Generate(new GenContext { Entities = new[] { root.FindObject("Order")! } });
        var contents = output.Single(f => f.Path.EndsWith("AppDbContext.g.cs")).Contents;
        Assert.Contains("Property(x => x.Status).HasConversion<string>()", contents);
    }

    [Fact]
    public void Generated_enum_type_declaration_is_identical_regardless_of_intValueMap()
    {
        var withMap = LoadModel(Model);
        var withoutMap = LoadModel("""
        { "metadata.root": { "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """);
        var entityGen = new EntityGenerator();
        var out1 = entityGen.Generate(new GenContext { Entities = new[] { withMap.FindObject("Order")! } });
        var out2 = entityGen.Generate(new GenContext { Entities = new[] { withoutMap.FindObject("Order")! } });
        Assert.Equal(
            out1.Single(f => f.Path.EndsWith("Order.g.cs")).Contents,
            out2.Single(f => f.Path.EndsWith("Order.g.cs")).Contents);
    }
}
```

> Match `GenContext`'s actual construction and `DbContextGenerator`/`EntityGenerator`'s actual `Generate` signature/output shape (`EmittedFile`-equivalent with `Path`/`Contents`) against an existing test like `EnumConformanceTests.cs` before finalizing — the sketch above follows that file's established pattern (confirmed via research) but adjust names/types to match exactly.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter EnumIntValueMapConversionTests`
Expected: FAIL — `Int_backed_enum_emits_a_custom_HasConversion_lambda_pair` fails (currently emits `HasConversion<string>()` unconditionally); the other two pass already (nothing has changed yet, so they describe current/target-preserving behavior).

- [ ] **Step 3: Add the reader helper to `DbContextGenerator.cs`**

Edit `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs` — add near the top of the class:

```csharp
    /// <summary>
    /// Reads @intValueMap off a field.enum MetaField, if present. Object-shaped JSON
    /// attrs parse to IReadOnlyDictionary&lt;string, object?&gt; with each number boxed
    /// as long (DataConverter.ParseNumber: "integers are always long").
    /// </summary>
    private static IReadOnlyDictionary<string, long>? TryGetIntValueMap(MetaField f)
    {
        if (f.Attr(FieldConstants.FIELD_ATTR_INT_VALUE_MAP) is not IReadOnlyDictionary<string, object?> raw)
            return null;
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var (key, value) in raw)
        {
            result[key] = value switch
            {
                long l => l,
                int i => i,
                _ => Convert.ToInt64(value),
            };
        }
        return result;
    }
```

- [ ] **Step 4: Run tests**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter EnumIntValueMapConversionTests`
Expected: still FAIL on the same test (helper exists but isn't called yet) — this step only adds plumbing, verified by the build succeeding with no new test passing.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs server/csharp/MetaObjects.Codegen.Tests/EnumIntValueMapConversionTests.cs
git commit -m "feat(csharp): add TryGetIntValueMap reader helper to DbContextGenerator"
```

---

### Task 2: Custom `HasConversion` for the scalar + array enum loops

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs`

**Interfaces:**
- Consumes: `TryGetIntValueMap` (Task 1).

- [ ] **Step 1: Update the scalar-enum branch**

Edit `EmitFieldTypeConfig`'s enum loop (research lines 353-363):

```csharp
    foreach (var f in fieldList.Where(f => f.SubType == FIELD_SUBTYPE_ENUM))
    {
        var prop = CSharpNaming.Pascal(f.Name);
        var intValueMap = TryGetIntValueMap(f);
        // ADR-0039: resolving — array-ness inheritable via extends. Array-of-enum uses the
        // EF Core 8 primitive collection with a per-element string conversion so members
        // persist as symbols (["DRAFT"]), not int ordinals ([0]).
        if (f.ResolvedIsArray())
        {
            modelLines.Add($"        modelBuilder.Entity<{className}>().PrimitiveCollection(x => x.{prop}).ElementType().HasConversion<string>();");
        }
        else if (intValueMap is not null)
        {
            var typeName = CSharpNaming.EnumTypeName(entity, f);
            var toProvider = string.Join(", ", intValueMap.Select(kv => $"{{ {typeName}.{kv.Key}, {kv.Value} }}"));
            var fromProvider = string.Join(", ", intValueMap.Select(kv => $"{{ {kv.Value}, {typeName}.{kv.Key} }}"));
            modelLines.Add(
                $"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasConversion(" +
                $"v => new System.Collections.Generic.Dictionary<{typeName}, int> {{ {toProvider} }}[v], " +
                $"v => new System.Collections.Generic.Dictionary<int, {typeName}> {{ {fromProvider} }}[v]);");
        }
        else
        {
            modelLines.Add($"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasConversion<string>();");
        }
    }
```

> Building a fresh `Dictionary` literal inline on every conversion call is wasteful at runtime (re-allocated per row) but matches this file's existing style of self-contained one-line lambda emission (see the `field.uri` branch, which similarly allocates a `new System.Uri(v)` per call). If this needs to be optimized later, emit the two dictionaries as `private static readonly` fields on the `DbContext` partial class instead of inline literals — flag this as a follow-up rather than doing it here, to keep this task's diff minimal and match the file's existing emission style.

- [ ] **Step 2: Update the projection/read-model loop**

Edit the sibling loop at research lines 67-68 with the identical conditional (extract the scalar-branch logic from Step 1 into a small shared private method `EmitEnumConversion(string className, string prop, MetaField f, MetaObject owner, List<string> modelLines)` and call it from both loops, to avoid duplicating the dictionary-literal-building logic verbatim in two places).

- [ ] **Step 3: Run tests — confirm all pass**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter EnumIntValueMapConversionTests`
Expected: PASS — all 3 tests green.

- [ ] **Step 4: Run the full Codegen test suite**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests`
Expected: all pass, including the existing `EnumConformanceTests.cs` (string-backed enums unchanged) and the EF Core Roslyn compile-check suite (the generated `HasConversion` lambda must actually compile against the real EF Core API — this is the test that catches a syntax mistake in the emitted C#).

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs
git commit -m "feat(csharp): custom HasConversion lambda pair for int-backed field.enum"
```

---

### Task 3: EF Core Roslyn compile-check coverage

**Files:**
- Modify: whatever fixture the "EF Core 8 + Roslyn-compiles the generated AppDbContext" test (per the original `field.enum` design doc's "Completed follow-ups") already uses.

**Interfaces:**
- Consumes: Task 2.

- [ ] **Step 1: Add an int-backed enum field to the shared EF-compile-check fixture model**

Find the fixture model the existing "Roslyn-compiles the generated AppDbContext" test loads (per `docs/superpowers/specs/2026-05-23-enum-datatype-design.md`'s "Completed follow-ups" section — "a model exercising owned/jsonb/enum/enum-array/scalar-array/projection") and add a sibling int-backed enum field alongside the existing string-backed one.

- [ ] **Step 2: Run the compile-check test**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter <the actual compile-check test class name>`
Expected: PASS — zero Roslyn compile errors against the real EF Core 8 API surface, confirming the emitted `HasConversion` lambda syntax is genuinely valid (not just string-matched by the earlier unit tests).

- [ ] **Step 3: Run the full C# test suite**

Run: `cd server/csharp && dotnet test`
Expected: 100% pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(csharp): int-backed field.enum in the EF Core Roslyn compile-check fixture"
```

---

## After this plan lands

C# generates no DDL and no persistence-conformance round-trip runner of its own for the query corpus beyond what the shared `roundtrip-all-types` scenario already drives through its generated + deployed API (per the api-contract-conformance "generated fan-out" lane described in this repo's CLAUDE.md). Once the TS persistence plan's `intEnumVal` field lands in `meta.fitness.json` (shared canonical model), re-run C#'s persistence-conformance and api-contract-conformance suites to confirm the new field round-trips through the generated EF Core stack with zero additional code — that's the real end-to-end proof this plan's `HasConversion` lambda works, beyond the unit-level Roslyn compile check in Task 3.
