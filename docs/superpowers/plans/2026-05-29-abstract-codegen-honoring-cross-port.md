# Honor `abstract` in Codegen Across Ports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every codegen port (C#, Java/Spring, Kotlin, Python) refuse to emit instance/write artifacts for abstract entities, with a configurable knob for emitting an abstract *shape* artifact — verified by a shared cross-port fixture.

**Architecture:** Two separable concerns. (1) **Invariant:** abstract entities never produce instance/write artifacts (routes, repos, write DTOs, EF/Exposed tables, filter allowlists, validator entries, stored-procs, CREATE TABLE DDL) — unconditional. (2) **Shape knob** (`emitAbstractShapes`): whether an abstract entity emits an abstract class / interface / base model — a codegen-config option (default off for the flatten ports C#/Java/Kotlin; effectively on for Python because its concretes subclass the base). Each port consumes one shared `fixtures/codegen-conformance/abstract/` input and asserts behavior idiomatically.

**Tech Stack:** C# (.NET / xUnit), Java + Kotlin (Maven / JUnit), Python (pytest). Metadata loaded from canonical JSON.

**Spec:** `docs/superpowers/specs/2026-05-29-abstract-codegen-honoring-cross-port-design.md`

---

## Conventions used throughout

- **Abstract accessor per port:** C# `entity.IsAbstract`; Java `MetaData.ATTR_IS_ABSTRACT` (= `"isAbstract"`) via `hasMetaAttr`/`getMetaAttr`; Kotlin same; Python `entity.is_abstract`.
- **Run gates:** after each unit, run the full module suite green, then the **review + simplify gate** (code-reviewer AND code-simplifier), fix findings, then merge forward to `main`. Work happens in the `abstract-codegen-ports` worktree.
- **Commit cadence:** commit after each task (failing test + impl + green).

---

## File Structure

**Created:**
- `fixtures/codegen-conformance/abstract/input/meta.abstract.json` — shared input
- `fixtures/codegen-conformance/abstract/README.md` — what it verifies
- `server/csharp/MetaObjects.Codegen/InstanceArtifacts.cs` — C# guard helper
- `server/python/src/metaobjects/codegen/instance_artifacts.py` — Python guard helper
- Test files per port (listed in tasks)

**Modified:**
- C#: `EntityGenerator.cs`, `DbContextGenerator.cs`, `RoutesGenerator.cs`, `FilterAllowlistGenerator.cs`, `Migrate/ExpectedSchema.cs`, `Generator.cs` (GenConfig), `Cli/Program.cs`, `Cli/GenCommand.cs`
- Java: `SpringControllerGenerator.java`, `SpringDtoGenerator.java`, `SpringRepositoryGenerator.java`, `SpringFilterAllowlistGenerator.java`; `codegen-base/.../GeneratorUtil.java`; `metadata/.../io/util/IOUtil.java`; `metadata/.../loader/parser/BaseMetaDataParser.java`; `metadata/.../loader/parser/json/CanonicalJsonParser.java` (comments)
- Kotlin: `KotlinGenUtil.kt`, `KotlinExposedTableGenerator.kt`, `KotlinRelationsGenerator.kt`, `KotlinSpringControllerGenerator.kt`, `KotlinStoredProcGenerator.kt`, `KotlinValidatorGenerator.kt`
- Python: `router_generator.py`, `filter_allowlist_generator.py`, `migrate/expected_schema.py`, `codegen/config.py`, CLI entry

---

## Unit 0 — Shared cross-port fixture

### Task 0.1: Create the shared abstract fixture

**Files:**
- Create: `fixtures/codegen-conformance/abstract/input/meta.abstract.json`
- Create: `fixtures/codegen-conformance/abstract/README.md`

The fixture has three entities, deliberately structured to avoid the extends+multi-source trap: a **source-bearing standalone abstract** (`AbstractRecord`) to test table/routes/repo/DDL suppression; a **sourceless abstract base** (`BaseShape`) extended by a **concrete** (`Widget`) to test inherited-field completeness and (Python) base-model inheritance.

- [ ] **Step 1: Write the fixture input**

Create `fixtures/codegen-conformance/abstract/input/meta.abstract.json`:

```json
{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": { "name": "AbstractRecord", "abstract": true, "children": [
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "code", "@required": true, "@maxLength": 50, "@filterable": true } },
        { "source.rdb":   { "@table": "abstract_records" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ] } },
      { "object.entity": { "name": "BaseShape", "abstract": true, "children": [
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true, "@maxLength": 100 } }
      ] } },
      { "object.entity": { "name": "Widget", "extends": "acme::shop::BaseShape", "children": [
        { "field.string": { "name": "sku", "@filterable": true } },
        { "source.rdb":   { "@table": "widgets" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ] } }
    ]
  }
}
```

- [ ] **Step 2: Write the README documenting the invariant**

Create `fixtures/codegen-conformance/abstract/README.md`:

```markdown
# codegen-conformance / abstract

Shared input for the cross-port "honor `abstract` in codegen" guarantee. Each port's
own test suite loads `input/meta.abstract.json` and asserts (idiomatically — no
byte-identical cross-language expectation):

- **AbstractRecord** (`abstract: true`, has a `source.rdb` table): produces NO
  instance/write artifact — no table `abstract_records`, no routes/controller, no
  repository, no filter allowlist, no DbSet/registry entry, no `CREATE TABLE`.
- **BaseShape** (`abstract: true`, no source): same suppression. In Python it still
  emits a Pydantic base model (Widget subclasses it).
- **Widget** (concrete, `extends BaseShape`, own `source.rdb`): produces its full set of
  artifacts (table `widgets`, routes, repo, allowlist on `sku`) with inherited fields
  `id` + `name` present. Python: `class Widget(BaseShape)`.

The shape knob (`emitAbstractShapes`, default off for the flatten ports): when OFF the
abstract entities produce no shape artifact; when ON exactly one standalone abstract
class/interface each, still no instance/write artifact.
```

- [ ] **Step 3: Commit**

```bash
git add fixtures/codegen-conformance/abstract/
git commit -m "test(codegen-conformance): shared abstract fixture (invariant + knob)"
```

---

## Unit 1 — C#

### Task 1.1: `InstanceArtifacts` guard helper

**Files:**
- Create: `server/csharp/MetaObjects.Codegen/InstanceArtifacts.cs`
- Test: `server/csharp/MetaObjects.Codegen.Tests/InstanceArtifactsTests.cs`

- [ ] **Step 1: Write the failing test**

Create `server/csharp/MetaObjects.Codegen.Tests/InstanceArtifactsTests.cs`:

```csharp
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class InstanceArtifactsTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.long": { "name": "id" } } ]}},
      { "object.entity": { "name": "Concrete", "children": [
        { "field.long": { "name": "id" } }, { "source.rdb": { "@table": "concretes" } },
        { "identity.primary": { "@fields": "id" } } ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "ia.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    [Fact]
    public void IsAbstract_true_only_for_abstract_entity()
    {
        var root = Load();
        var bySub = root.Objects().ToDictionary(o => o.Name);
        Assert.True(InstanceArtifacts.IsAbstract(bySub["Base"]));
        Assert.False(InstanceArtifacts.IsAbstract(bySub["Concrete"]));
        Assert.False(InstanceArtifacts.EmitsInstanceArtifacts(bySub["Base"]));
        Assert.True(InstanceArtifacts.EmitsInstanceArtifacts(bySub["Concrete"]));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~IsAbstract_true_only"`
Expected: FAIL — `InstanceArtifacts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `server/csharp/MetaObjects.Codegen/InstanceArtifacts.cs`:

```csharp
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>
/// Framework-level guard for the abstract concept (mirrors the TS instance-artifacts
/// module). An abstract entity contributes shape via inheritance only — it must never
/// produce instantiable / write artifacts.
/// </summary>
public static class InstanceArtifacts
{
    /// <summary>True when the entity is abstract (`abstract: true`).</summary>
    public static bool IsAbstract(MetaObject entity) => entity.IsAbstract;

    /// <summary>
    /// True when the entity should produce instance artifacts of any kind
    /// (tables, routes, repositories, DbSet registration). False for abstract.
    /// </summary>
    public static bool EmitsInstanceArtifacts(MetaObject entity) => !entity.IsAbstract;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~IsAbstract_true_only"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects.Codegen/InstanceArtifacts.cs server/csharp/MetaObjects.Codegen.Tests/InstanceArtifactsTests.cs
git commit -m "feat(csharp-codegen): InstanceArtifacts abstract guard helper"
```

### Task 1.2: Suppress instance/write generators for abstract (shared fixture)

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generators/DbContextGenerator.cs`
- Modify: `server/csharp/MetaObjects.Codegen/Generators/RoutesGenerator.cs`
- Modify: `server/csharp/MetaObjects.Codegen/Generators/FilterAllowlistGenerator.cs`
- Test: `server/csharp/MetaObjects.Codegen.Tests/AbstractConformanceTests.cs`

- [ ] **Step 1: Write the failing test against the shared fixture**

Create `server/csharp/MetaObjects.Codegen.Tests/AbstractConformanceTests.cs`:

```csharp
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class AbstractConformanceTests
{
    // Repo-relative path from the test bin dir up to the shared fixture.
    private static readonly string FixtureDir =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            "../../../../../../fixtures/codegen-conformance/abstract/input"));

    private static MetaRoot Load()
    {
        var r = MetaDataLoader.FromDirectory(FixtureDir);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, bool emitAbstractShapes = false) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen", EmitAbstractShapes = emitAbstractShapes },
    };

    [Fact]
    public void DbContext_has_no_DbSet_for_abstract_entities()
    {
        var ctx = Ctx(Load());
        var src = string.Join("\n", new DbContextGenerator().Generate(ctx).Select(f => f.Content));
        Assert.DoesNotContain("DbSet<AbstractRecord>", src);
        Assert.DoesNotContain("DbSet<BaseShape>", src);
        Assert.Contains("DbSet<Widget>", src);
    }

    [Fact]
    public void Routes_not_emitted_for_abstract_entities()
    {
        var ctx = Ctx(Load());
        var paths = new RoutesGenerator().Generate(ctx).Select(f => f.Path).ToList();
        Assert.DoesNotContain("AbstractRecordRoutes.g.cs", paths);
        Assert.DoesNotContain("BaseShapeRoutes.g.cs", paths);
        Assert.Contains("WidgetRoutes.g.cs", paths);
    }

    [Fact]
    public void FilterAllowlist_not_emitted_for_abstract_entities()
    {
        var ctx = Ctx(Load());
        var paths = new FilterAllowlistGenerator().Generate(ctx).Select(f => f.Path).ToList();
        Assert.DoesNotContain("AbstractRecordFilterAllowlist.g.cs", paths);
        Assert.Contains("WidgetFilterAllowlist.g.cs", paths);
    }
}
```

> Note: confirm the exact emitted file names by reading each generator's `GenerateOne`/path logic; adjust the path strings if the suffix differs (e.g. `.g.cs` vs `Routes.cs`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~AbstractConformanceTests"`
Expected: FAIL — abstract entities currently emit DbSet/routes/allowlist. (Also fails to compile until `EmitAbstractShapes` exists — do Task 1.4 Step 3's GenConfig field first if the compiler blocks; otherwise temporarily drop the `emitAbstractShapes` arg. Recommended: implement Task 1.4 Step 3 GenConfig field now, then return.)

- [ ] **Step 3: Add the guard to each instance/write generator**

In `DbContextGenerator.cs`, the entity loop filters `o.IsEntity() || o.DbView is not null`. Add the abstract guard:

```csharp
var objects = ctx.Entities
    .Where(o => (o.IsEntity() || o.DbView is not null) && InstanceArtifacts.EmitsInstanceArtifacts(o))
    .OrderBy(o => o.Name, StringComparer.Ordinal)
    .ToList();
```

In `RoutesGenerator.cs`, update `Filter`:

```csharp
protected override bool Filter(MetaObject entity) =>
    (entity.IsEntity() || entity.DbView is not null) && InstanceArtifacts.EmitsInstanceArtifacts(entity);
```

In `FilterAllowlistGenerator.cs`, update `Filter`:

```csharp
protected override bool Filter(MetaObject entity) =>
    entity.IsEntity() && !entity.IsReadOnlyProjection() && InstanceArtifacts.EmitsInstanceArtifacts(entity);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~AbstractConformanceTests"`
Expected: PASS (the three suppression tests; the DDL test comes in Task 1.3).

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects.Codegen/Generators server/csharp/MetaObjects.Codegen.Tests/AbstractConformanceTests.cs
git commit -m "fix(csharp-codegen): skip DbSet/routes/allowlist for abstract entities"
```

### Task 1.3: Suppress CREATE TABLE DDL for abstract

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Migrate/ExpectedSchema.cs:36-49`
- Test: append to `server/csharp/MetaObjects.Codegen.Tests/AbstractConformanceTests.cs`

- [ ] **Step 1: Write the failing test**

Append to `AbstractConformanceTests.cs`:

```csharp
    [Fact]
    public void ExpectedSchema_has_no_table_for_abstract_entities()
    {
        var snap = MetaObjects.Codegen.Migrate.ExpectedSchema.Build(Load());
        var tableNames = snap.Tables.Select(t => t.Name).ToList();
        Assert.DoesNotContain("abstract_records", tableNames);
        Assert.Contains("widgets", tableNames);
    }
```

> Confirm `SchemaSnapshot.Tables` and `TableDescriptor.Name` property names by reading `ExpectedSchema.cs`; adjust if different.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~ExpectedSchema_has_no_table"`
Expected: FAIL — abstract entity with a writable source currently yields a table.

- [ ] **Step 3: Add the guard**

In `ExpectedSchema.Build`, add `!o.IsAbstract` to the writable-entities filter:

```csharp
var writableEntities = root.Objects()
    .Where(o => o.IsEntity() && !o.IsAbstract && o.FindPrimaryWritableSource() is not null)
    .OrderBy(o => o.Name, StringComparer.Ordinal)
    .ToList();
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~ExpectedSchema_has_no_table"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects.Codegen/Migrate/ExpectedSchema.cs server/csharp/MetaObjects.Codegen.Tests/AbstractConformanceTests.cs
git commit -m "fix(csharp-codegen): no CREATE TABLE for abstract entities"
```

### Task 1.4: `EmitAbstractShapes` config knob + EntityGenerator shape behavior

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/Generator.cs` (GenConfig record)
- Modify: `server/csharp/MetaObjects.Codegen/Generators/EntityGenerator.cs`
- Modify: `server/csharp/MetaObjects.Cli/Program.cs`, `server/csharp/MetaObjects.Cli/GenCommand.cs`
- Test: append to `AbstractConformanceTests.cs`

- [ ] **Step 1: Write the failing tests (knob off + on)**

Append to `AbstractConformanceTests.cs`:

```csharp
    [Fact]
    public void EntityGenerator_off_emits_no_shape_for_abstract()
    {
        var ctx = Ctx(Load(), emitAbstractShapes: false);
        var paths = new EntityGenerator().Generate(ctx).Select(f => f.Path).ToList();
        Assert.DoesNotContain("AbstractRecord.g.cs", paths);
        Assert.DoesNotContain("BaseShape.g.cs", paths);
        Assert.Contains("Widget.g.cs", paths);
    }

    [Fact]
    public void EntityGenerator_on_emits_abstract_class_shape_without_table()
    {
        var ctx = Ctx(Load(), emitAbstractShapes: true);
        var file = new EntityGenerator().Generate(ctx).Single(f => f.Path == "AbstractRecord.g.cs");
        Assert.Contains("public abstract class AbstractRecord", file.Content);
        Assert.DoesNotContain("[Table(", file.Content);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~EntityGenerator_off OR Name~EntityGenerator_on"`
Expected: FAIL — GenConfig has no `EmitAbstractShapes`; EntityGenerator emits a `[Table]` class for abstract.

- [ ] **Step 3: Add the GenConfig field**

In `Generator.cs`, add to the `GenConfig` record:

```csharp
/// <summary>
/// When true, abstract entities emit a standalone `abstract class` shape (no EF
/// mapping); when false (default) they emit nothing. Instance/write artifacts are
/// suppressed for abstract entities regardless.
/// </summary>
public bool EmitAbstractShapes { get; init; } = false;
```

- [ ] **Step 4: Update EntityGenerator**

In `EntityGenerator.cs`, after computing `mapped`, branch abstract handling. Replace the entity loop so that:

```csharp
foreach (var o in mapped)
{
    if (o.IsAbstract)
    {
        if (!ctx.Config.EmitAbstractShapes) continue;        // off → emit nothing
        yield return EmitAbstractShapeClass(o, ctx);          // on → standalone abstract class
        continue;
    }
    yield return EmitMappedClass(o, ctx);                     // existing path
}
```

Add `EmitAbstractShapeClass` next to `EmitMappedClass` — same property emission, but:
emit `public abstract class {className}` (add the `abstract` modifier), and **omit** the
`[Table(...)]` class attribute and the `[Key]`/`[Column]` EF property attributes (it is a
shape, not an EF entity). Reuse the existing scalar/enum property rendering for the body.
Concretely, copy `EmitMappedClass`, change the class line to include `abstract`, and skip
the `[Table]`/`[Key]`/`[Column]` attribute appends.

- [ ] **Step 5: Thread the CLI flag**

In `Cli/Program.cs` `RunGen`, add flag parsing:

```csharp
bool emitAbstractShapes = false;
// inside the for-loop:
else if (rest[i] == "--emit-abstract-shapes") emitAbstractShapes = true;
// update the usage string and the call:
var outcome = GenCommand.Run(metadataDir, outDir, ns, emitAbstractShapes);
```

In `Cli/GenCommand.cs`, widen `Run`:

```csharp
public static Outcome Run(string metadataDir, string outDir, string ns, bool emitAbstractShapes = false)
{
    var load = MetaDataLoader.FromDirectory(metadataDir);
    var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
    if (loadErrors.Count > 0) return new Outcome(loadErrors, null);
    var config = new GenConfig { OutDir = outDir, Namespace = ns, EmitAbstractShapes = emitAbstractShapes };
    var result = CodegenRunner.Run(config, load.Root, DefaultGenerators());
    return new Outcome(loadErrors, result);
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter "Name~AbstractConformanceTests"`
Expected: PASS (all C# abstract tests).

- [ ] **Step 7: Commit**

```bash
git add server/csharp/MetaObjects.Codegen server/csharp/MetaObjects.Cli server/csharp/MetaObjects.Codegen.Tests
git commit -m "feat(csharp-codegen): emitAbstractShapes knob + abstract-class shape"
```

### Task 1.5: C# full suite + gate + merge

- [ ] **Step 1:** Run `cd server/csharp && dotnet test` — all green.
- [ ] **Step 2:** Run code-reviewer on the C# diff; fix findings.
- [ ] **Step 3:** Run code-simplifier on the C# diff; apply.
- [ ] **Step 4:** Re-run `dotnet test` — green. Merge `abstract-codegen-ports` work for C# forward to `main` (FF/merge onto current tip; never rewrite main).

---

## Unit 2 — Java/Spring (includes `_isAbstract` → `isAbstract` unification)

### Task 2.1: Unify the abstract accessor on `isAbstract`

**Files:**
- Modify: `server/java/codegen-base/src/main/java/com/metaobjects/generator/util/GeneratorUtil.java:236-242`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/io/util/IOUtil.java:65-70`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/parser/BaseMetaDataParser.java:87,104`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/parser/json/CanonicalJsonParser.java` (comments lines 63/96/690)
- Test: `server/java/codegen-base/src/test/java/com/metaobjects/generator/util/GeneratorUtilAbstractTest.java`

- [ ] **Step 1: Write the failing test**

Create `server/java/codegen-base/src/test/java/com/metaobjects/generator/util/GeneratorUtilAbstractTest.java`:

```java
package com.metaobjects.generator.util;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GeneratorUtilAbstractTest extends SharedRegistryTestBase {

    private static final String FX = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.long": { "name": "id" } } ]}},
          { "object.entity": { "name": "Concrete", "children": [
            { "field.long": { "name": "id" } } ]}}
        ]}}
        """;

    @Test
    public void isAbstract_reads_canonical_isAbstract_attribute() throws Exception {
        MetaDataLoader loader = MetaDataLoader.fromString("gu-abstract", FX);
        MetaObject base = loader.getMetaObjectByName("acme::Base");
        MetaObject concrete = loader.getMetaObjectByName("acme::Concrete");
        assertTrue("abstract entity must report isAbstract=true", GeneratorUtil.isAbstract(base));
        assertFalse("concrete entity must report isAbstract=false", GeneratorUtil.isAbstract(concrete));
    }
}
```

> Confirm `MetaDataLoader.fromString(name, content)` exists (it is used by the Kotlin `loadString` facade). If not, load via the codegen-spring `SpringTestFixtures.loadFixture` pattern (write to a temp file, `setSourceURIs`, `init()`), and adjust imports accordingly.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -pl codegen-base test -Dtest=GeneratorUtilAbstractTest`
Expected: FAIL — `GeneratorUtil.isAbstract` reads `"_isAbstract"`, returns false for canonical metadata.

- [ ] **Step 3: Fix the accessor**

In `GeneratorUtil.java`, replace the body of `isAbstract`:

```java
import com.metaobjects.MetaData;
// ...
public static boolean isAbstract( MetaData md ) {
    if ( md.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT)
            && Boolean.TRUE.equals( md.getMetaAttr( MetaData.ATTR_IS_ABSTRACT ).getValue())) {
        return true;
    }
    return false;
}
```

Apply the identical change to `IOUtil.isAbstract` in `io/util/IOUtil.java`.

- [ ] **Step 4: Remove the legacy `_isAbstract` constant + reserved registration**

In `BaseMetaDataParser.java`, delete the `ATTR_ISABSTRACT = "_isAbstract"` constant (line 87) and the `reservedAttributes.add( ATTR_ISABSTRACT );` line (line 104). Fix the stale comments in `CanonicalJsonParser.java` (lines 63, 96, 690) to say `isAbstract` instead of `_isAbstract`.

- [ ] **Step 5: Run the broad Java + conformance suites (deletion gate)**

Run: `cd server/java && mvn -pl metadata,codegen-base test`
Expected: PASS. If a legacy resource (e.g. `test-interface-metadata.json`) references `_isAbstract` and fails, STOP and report — do not silently re-add the constant; surface the finding to the user.

- [ ] **Step 6: Commit**

```bash
git add server/java/codegen-base server/java/metadata
git commit -m "refactor(java-metadata): unify abstract accessor on isAbstract; drop _isAbstract"
```

### Task 2.2: Suppress instance/write generators for abstract (shared fixture)

**Files:**
- Modify: `server/java/codegen-spring/.../SpringControllerGenerator.java:96-106`
- Modify: `server/java/codegen-spring/.../SpringRepositoryGenerator.java:53-62`
- Modify: `server/java/codegen-spring/.../SpringFilterAllowlistGenerator.java:97-106`
- Modify: `server/java/codegen-spring/.../SpringDtoGenerator.java:54-60` (write/DTO path)
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/AbstractConformanceTest.java`

- [ ] **Step 1: Write the failing test against the shared fixture**

Create `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/AbstractConformanceTest.java`:

```java
package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class AbstractConformanceTest extends SharedRegistryTestBase {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    /** Loads the repo-shared fixture from fixtures/codegen-conformance/abstract/input. */
    private MetaDataLoader loadShared() throws Exception {
        // Resolve the repo root from this module's working dir (server/java/codegen-spring).
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path input = repoRoot.resolve("fixtures/codegen-conformance/abstract/input/meta.abstract.json");
        assertTrue("shared fixture missing at " + input, Files.exists(input));
        return SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "abstract",
            Files.readString(input));
    }

    private Path runController() throws Exception {
        Path out = tmp.newFolder("ctrl").toPath();
        SpringControllerGenerator gen = new SpringControllerGenerator();
        Map<String,String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        gen.setArgs(args);
        gen.execute(loadShared());
        return out;
    }

    @Test
    public void controllers_skip_abstract_entities() throws Exception {
        Path out = runController();
        assertFalse(Files.exists(out.resolve("acme/shop/AbstractRecordController.java")));
        assertFalse(Files.exists(out.resolve("acme/shop/BaseShapeController.java")));
        assertTrue(Files.exists(out.resolve("acme/shop/WidgetController.java")));
    }
}
```

> Confirm the generated path/file naming (`acme/shop/WidgetController.java`) by reading `SpringControllerGenerator.emit`. Adjust the relative `repoRoot` hops if the module's test working dir differs (verify with a temporary `System.out.println(repoRoot)`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -pl codegen-spring test -Dtest=AbstractConformanceTest`
Expected: FAIL — abstract entities currently get controllers.

- [ ] **Step 3: Add the guard to each generator's `execute` loop**

In each of `SpringControllerGenerator`, `SpringRepositoryGenerator`, `SpringFilterAllowlistGenerator`, and `SpringDtoGenerator`, inside the `for (MetaObject entity : loader.getMetaObjects())` loop after the `SUBTYPE_ENTITY` check, add:

```java
if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) continue;
```

(For `SpringDtoGenerator`, this is the write/DTO path; the shape-knob path is added in Task 2.3.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && mvn -pl codegen-spring test -Dtest=AbstractConformanceTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/codegen-spring
git commit -m "fix(codegen-spring): skip controllers/repos/DTOs/allowlists for abstract"
```

### Task 2.3: `emitAbstractShapes` generator arg + DTO shape interface

**Files:**
- Modify: `server/java/codegen-spring/.../SpringDtoGenerator.java`
- Test: append to `AbstractConformanceTest.java`

- [ ] **Step 1: Write the failing tests (knob off + on)**

Append to `AbstractConformanceTest.java`:

```java
    private Path runDto(boolean emitAbstractShapes) throws Exception {
        Path out = tmp.newFolder(emitAbstractShapes ? "dto-on" : "dto-off").toPath();
        SpringDtoGenerator gen = new SpringDtoGenerator();
        Map<String,String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        args.put("emitAbstractShapes", String.valueOf(emitAbstractShapes));
        gen.setArgs(args);
        gen.execute(loadShared());
        return out;
    }

    @Test
    public void dto_off_emits_no_shape_for_abstract() throws Exception {
        Path out = runDto(false);
        assertFalse(Files.exists(out.resolve("acme/shop/AbstractRecordDto.java")));
        assertFalse(Files.exists(out.resolve("acme/shop/BaseShapeDto.java")));
        assertTrue(Files.exists(out.resolve("acme/shop/WidgetDto.java")));
    }

    @Test
    public void dto_on_emits_interface_shape_for_abstract() throws Exception {
        Path out = runDto(true);
        Path shape = out.resolve("acme/shop/AbstractRecordDto.java");
        assertTrue(Files.exists(shape));
        String src = Files.readString(shape);
        assertTrue("abstract shape must be an interface; saw:\n" + src,
            src.contains("public interface AbstractRecordDto"));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -pl codegen-spring test -Dtest=AbstractConformanceTest#dto_on_emits_interface_shape_for_abstract`
Expected: FAIL — no shape emitted; arg unrecognized.

- [ ] **Step 3: Implement the knob in SpringDtoGenerator**

In `SpringDtoGenerator.execute`, read the arg and branch:

```java
boolean emitAbstractShapes = Boolean.parseBoolean(getArg("emitAbstractShapes", "false"));
for (MetaObject entity : loader.getMetaObjects()) {
    if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) continue;
    if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) {
        if (emitAbstractShapes) emitAbstractShape(entity, outRoot);  // interface
        continue;
    }
    emit(entity, outRoot);
}
```

Add `emitAbstractShape` mirroring `emit` but rendering a Java `interface` whose accessor
methods correspond to the entity's fields (records cannot be a base type). Use the same
`scalarFields(entity)` + `SpringTypeMapper.javaTypeName(field)` you already use; emit
`<Type> <name>();` accessor signatures inside `public interface <Name>Dto { ... }`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && mvn -pl codegen-spring test -Dtest=AbstractConformanceTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/codegen-spring
git commit -m "feat(codegen-spring): emitAbstractShapes arg + abstract DTO interface"
```

### Task 2.4: Java full suite + gate + merge

- [ ] **Step 1:** Run `cd server/java && mvn -pl metadata,codegen-base,codegen-spring test` — green. Also run the conformance test module to confirm no metamodel regression: `mvn -pl metadata test -Dtest=ConformanceTest`.
- [ ] **Step 2:** code-reviewer on the Java diff; fix.
- [ ] **Step 3:** code-simplifier on the Java diff; apply.
- [ ] **Step 4:** Re-run the suites green. Merge forward to `main`.

---

## Unit 3 — Kotlin

### Task 3.1: Shared `isAbstractEntity` in `KotlinGenUtil`

**Files:**
- Modify: `server/java/codegen-kotlin/.../KotlinGenUtil.kt`
- Modify: `server/java/codegen-kotlin/.../KotlinEntityGenerator.kt` (use the shared helper instead of its private copy)
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinGenUtilAbstractTest.kt`

- [ ] **Step 1: Write the failing test**

Create `KotlinGenUtilAbstractTest.kt`:

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinGenUtilAbstractTest {
    private val fx = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.string": { "name": "id" } } ] } },
        { "object.entity": { "name": "Concrete", "children": [
            { "field.string": { "name": "id" } } ] } }
      ] }
    }""".trimIndent()

    @Test fun `isAbstractEntity reads canonical isAbstract`() {
        val loader = loadString("kgu-abstract", fx)
        val base = loader.metaObjects.first { it.name == "acme::demo::Base" }
        val concrete = loader.metaObjects.first { it.name == "acme::demo::Concrete" }
        assertTrue(KotlinGenUtil.isAbstractEntity(base))
        assertFalse(KotlinGenUtil.isAbstractEntity(concrete))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinGenUtilAbstractTest`
Expected: FAIL — `KotlinGenUtil.isAbstractEntity` does not exist.

- [ ] **Step 3: Add the shared helper and reuse it in KotlinEntityGenerator**

In `KotlinGenUtil.kt`, add:

```kotlin
import com.metaobjects.MetaData

/** True iff the entity carries its own `isAbstract=true` attribute (own-only, not inherited). */
fun isAbstractEntity(obj: MetaObject): Boolean {
    if (!obj.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)) return false
    val v = runCatching { obj.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).value }.getOrNull()
    return when (v) {
        is Boolean -> v
        is String -> v.equals("true", ignoreCase = true)
        else -> false
    }
}
```

In `KotlinEntityGenerator.kt`, replace its private `isAbstract(obj)` calls with
`KotlinGenUtil.isAbstractEntity(obj)` and delete the private method (DRY).

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinGenUtilAbstractTest,KotlinEntityGeneratorTest`
Expected: PASS (including the existing `abstract entities are skipped` test).

- [ ] **Step 5: Commit**

```bash
git add server/java/codegen-kotlin
git commit -m "refactor(codegen-kotlin): shared KotlinGenUtil.isAbstractEntity"
```

### Task 3.2: Suppress the five instance/write generators for abstract (shared fixture)

**Files:**
- Modify: `KotlinExposedTableGenerator.kt:59`, `KotlinRelationsGenerator.kt:65`, `KotlinSpringControllerGenerator.kt:86`, `KotlinStoredProcGenerator.kt:70`, `KotlinValidatorGenerator.kt:40`
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinAbstractConformanceTest.kt`

- [ ] **Step 1: Write the failing test against the shared fixture**

Create `KotlinAbstractConformanceTest.kt`:

```kotlin
package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinAbstractConformanceTest {

    private fun loadShared() =
        loadString("abstract", Files.readString(
            Path.of(System.getProperty("user.dir")).resolve("../../..")
                .normalize().resolve("fixtures/codegen-conformance/abstract/input/meta.abstract.json")))

    private fun runExposed(): Path {
        val out = Files.createTempDirectory("ktbl-abstract-")
        val gen = KotlinExposedTableGenerator()
        gen.setArgs(mapOf("outputDir" to out.toString()))
        gen.execute(loadShared())
        return out
    }

    @Test fun `exposed tables skip abstract entities`() {
        val out = runExposed()
        try {
            assertFalse(Files.exists(out.resolve("acme/shop/AbstractRecordTable.kt")))
            assertTrue(Files.exists(out.resolve("acme/shop/WidgetTable.kt")))
        } finally { out.toFile().deleteRecursively() }
    }
}
```

> Confirm emitted Table file naming (`AbstractRecordTable.kt` / `WidgetTable.kt`) by reading `KotlinExposedTableGenerator.emit`. Adjust the `../../..` hop count after verifying the module's test working dir.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinAbstractConformanceTest`
Expected: FAIL — abstract `AbstractRecord` currently emits a Table.

- [ ] **Step 3: Add the guard to each of the five generators**

In each generator's `for (entity in loader.metaObjects)` loop, right after the
`if (entity.subType != MetaObject.SUBTYPE_ENTITY) continue` line, add:

```kotlin
if (KotlinGenUtil.isAbstractEntity(entity)) continue
```

Apply to: `KotlinExposedTableGenerator`, `KotlinRelationsGenerator`,
`KotlinSpringControllerGenerator`, `KotlinStoredProcGenerator`, `KotlinValidatorGenerator`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinAbstractConformanceTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/codegen-kotlin
git commit -m "fix(codegen-kotlin): skip table/relations/controller/proc/validator for abstract"
```

### Task 3.3: `emitAbstractShapes` arg + abstract data-class/interface shape

**Files:**
- Modify: `KotlinEntityGenerator.kt`
- Test: append to `KotlinAbstractConformanceTest.kt`

- [ ] **Step 1: Write the failing tests (knob off + on)**

Append to `KotlinAbstractConformanceTest.kt`:

```kotlin
    private fun runEntity(emitAbstractShapes: Boolean): Path {
        val out = Files.createTempDirectory("kent-abstract-")
        val gen = KotlinEntityGenerator()
        gen.setArgs(mapOf("outputDir" to out.toString(),
            "emitAbstractShapes" to emitAbstractShapes.toString()))
        gen.execute(loadShared())
        return out
    }

    @Test fun `entity off emits no shape for abstract`() {
        val out = runEntity(false)
        try {
            assertFalse(Files.exists(out.resolve("acme/shop/AbstractRecord.kt")))
            assertFalse(Files.exists(out.resolve("acme/shop/BaseShape.kt")))
            assertTrue(Files.exists(out.resolve("acme/shop/Widget.kt")))
        } finally { out.toFile().deleteRecursively() }
    }

    @Test fun `entity on emits interface shape for abstract`() {
        val out = runEntity(true)
        try {
            val shape = out.resolve("acme/shop/AbstractRecord.kt")
            assertTrue(Files.exists(shape))
            assertTrue("interface AbstractRecord" in Files.readString(shape))
        } finally { out.toFile().deleteRecursively() }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinAbstractConformanceTest`
Expected: FAIL — `entity on` finds no shape file.

- [ ] **Step 3: Implement the knob**

In `KotlinEntityGenerator.execute`, read the arg and branch:

```kotlin
val emitAbstractShapes = getArg("emitAbstractShapes", "false").toBoolean()
for (obj in loader.metaObjects) {
    if (obj.subType !in EMITTED_SUBTYPES) continue
    if (KotlinGenUtil.isAbstractEntity(obj)) {
        if (emitAbstractShapes) emitAbstractShape(obj, outRoot, loader)
        continue
    }
    emit(obj, outRoot, loader)
}
```

Add `emitAbstractShape` using KotlinPoet `TypeSpec.interfaceBuilder(shortName)` with a
read-only `val <name>: <Type>` property per field (use `resolvePropertyType` +
`KotlinGenUtil.isRequiredField`, same as `emit`). Write to the same package path.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinAbstractConformanceTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/codegen-kotlin
git commit -m "feat(codegen-kotlin): emitAbstractShapes arg + abstract interface shape"
```

### Task 3.4: Kotlin full suite + gate + merge

- [ ] **Step 1:** Run `cd server/java && mvn -pl codegen-kotlin test` — green. Run `integration-tests-kotlin` if it exercises codegen: `mvn -pl integration-tests-kotlin test`.
- [ ] **Step 2:** code-reviewer on the Kotlin diff; fix.
- [ ] **Step 3:** code-simplifier on the Kotlin diff; apply.
- [ ] **Step 4:** Re-run green. Merge forward to `main`.

---

## Unit 4 — Python (special case: keep the base model)

### Task 4.1: `instance_artifacts.py` guard helper

**Files:**
- Create: `server/python/src/metaobjects/codegen/instance_artifacts.py`
- Test: `server/python/tests/codegen/test_instance_artifacts.py`

- [ ] **Step 1: Write the failing test**

Create `server/python/tests/codegen/test_instance_artifacts.py`:

```python
import metaobjects.core_types  # noqa: F401
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts, is_abstract
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _entity(name: str, *, abstract: bool = False) -> MetaObject:
    o = MetaObject(TYPE_OBJECT, "entity", name)
    o.is_abstract = abstract
    return o


def test_is_abstract_and_emits_instance_artifacts() -> None:
    base = _entity("Base", abstract=True)
    concrete = _entity("Concrete")
    assert is_abstract(base) is True
    assert is_abstract(concrete) is False
    assert emits_instance_artifacts(base) is False
    assert emits_instance_artifacts(concrete) is True
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/python && python3 -m pytest tests/codegen/test_instance_artifacts.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `server/python/src/metaobjects/codegen/instance_artifacts.py`:

```python
"""Guard for the abstract concept (mirrors the TS instance-artifacts module).

An abstract entity contributes shape via inheritance only — it must never produce
instance/write artifacts (routers, filter allowlists, CREATE TABLE DDL). The Pydantic
*model* is a separate, configurable shape concern handled in entity_model.
"""

from metaobjects.meta.core.object.meta_object import MetaObject


def is_abstract(entity: MetaObject) -> bool:
    return entity.is_abstract is True


def emits_instance_artifacts(entity: MetaObject) -> bool:
    return not is_abstract(entity)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/python && python3 -m pytest tests/codegen/test_instance_artifacts.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/python/src/metaobjects/codegen/instance_artifacts.py server/python/tests/codegen/test_instance_artifacts.py
git commit -m "feat(python-codegen): instance_artifacts abstract guard"
```

### Task 4.2: Suppress router + filter allowlist for abstract

**Files:**
- Modify: `server/python/src/metaobjects/codegen/generators/router_generator.py` (`render_router`, ~line 95)
- Modify: `server/python/src/metaobjects/codegen/generators/filter_allowlist_generator.py` (`render_filter_allowlist`, ~line 146)
- Test: `server/python/tests/codegen/test_abstract_conformance.py`

- [ ] **Step 1: Write the failing test (uses the shared fixture)**

Create `server/python/tests/codegen/test_abstract_conformance.py`:

```python
import json
from pathlib import Path

import metaobjects.core_types  # noqa: F401
from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.entity_model import render_entity_model

_FIXTURE = (
    Path(__file__).resolve().parents[4]
    / "fixtures/codegen-conformance/abstract/input/meta.abstract.json"
)


def _root():
    return MetaDataLoader.from_directory(_FIXTURE.parent).root


def _by_name():
    return {o.name.split("::")[-1]: o for o in _root().own_children() if hasattr(o, "own_fields")}


def test_router_skipped_for_abstract() -> None:
    objs = _by_name()
    assert render_router(objs["AbstractRecord"]) is None
    assert render_router(objs["Widget"]) is not None


def test_filter_allowlist_skipped_for_abstract() -> None:
    objs = _by_name()
    assert render_filter_allowlist(objs["AbstractRecord"]) is None
    assert render_filter_allowlist(objs["Widget"]) is not None
```

> Verify `parents[4]` resolves to the repo root from `server/python/tests/codegen/`; adjust the index if needed. Confirm `MetaDataLoader.from_directory` and `.own_children()` per the runner tests.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/python && python3 -m pytest tests/codegen/test_abstract_conformance.py -v`
Expected: FAIL — abstract `AbstractRecord` (has a table source) currently renders a router + allowlist.

- [ ] **Step 3: Add the guard**

In `router_generator.py` `render_router`, near the top (after resolving the entity, before building output), add:

```python
from metaobjects.codegen.instance_artifacts import emits_instance_artifacts
# ...
if not emits_instance_artifacts(entity):
    return None
```

Apply the same early-return to `filter_allowlist_generator.py` `render_filter_allowlist`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/python && python3 -m pytest tests/codegen/test_abstract_conformance.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/python/src/metaobjects/codegen/generators server/python/tests/codegen/test_abstract_conformance.py
git commit -m "fix(python-codegen): skip router + filter allowlist for abstract"
```

### Task 4.3: Suppress CREATE TABLE DDL for abstract

**Files:**
- Modify: `server/python/src/metaobjects/migrate/expected_schema.py` (`build_expected_schema`, ~line 52)
- Test: append to `server/python/tests/codegen/test_abstract_conformance.py`

- [ ] **Step 1: Write the failing test**

Append to `test_abstract_conformance.py`:

```python
from metaobjects.migrate.expected_schema import build_expected_schema


def test_no_table_for_abstract_entity() -> None:
    snap = build_expected_schema(_root())
    names = {t.name for t in snap.tables}
    assert "abstract_records" not in names
    assert "widgets" in names
```

> Confirm `SchemaSnapshot.tables` and table `.name` attribute names by reading `expected_schema.py`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/python && python3 -m pytest tests/codegen/test_abstract_conformance.py::test_no_table_for_abstract_entity -v`
Expected: FAIL — abstract entity with a writable source currently yields a table.

- [ ] **Step 3: Add the guard**

In `build_expected_schema`, in the loop over `root.own_children()`, after the
`isinstance(child, MetaObject)` check add:

```python
if child.is_abstract:
    continue
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/python && python3 -m pytest tests/codegen/test_abstract_conformance.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/python/src/metaobjects/migrate/expected_schema.py server/python/tests/codegen/test_abstract_conformance.py
git commit -m "fix(python-migrate): no CREATE TABLE for abstract entities"
```

### Task 4.4: Keep the base model; honor `emit_abstract_shapes` config (default on)

**Files:**
- Modify: `server/python/src/metaobjects/codegen/config.py`
- Modify: `server/python/src/metaobjects/codegen/generators/entity_model.py`
- Modify: Python CLI entry that builds `GenConfig`
- Test: append to `test_abstract_conformance.py`

- [ ] **Step 1: Write the failing tests**

Append to `test_abstract_conformance.py`:

```python
def test_entity_model_emits_abstract_base_and_concrete_inherits() -> None:
    objs = _by_name()
    # The abstract base model is still emitted (concretes subclass it).
    base_out = render_entity_model(objs["BaseShape"])
    assert "class BaseShape(BaseModel):" in base_out
    # The concrete subclasses the base and imports it.
    widget_out = render_entity_model(objs["Widget"])
    assert "from .BaseShape import BaseShape" in widget_out
    assert "class Widget(BaseShape):" in widget_out
    assert "sku" in widget_out
```

> This asserts current Python behavior remains intact (regression guard) — Python keeps emitting the abstract base model. The `emit_abstract_shapes` config field is added for cross-port uniformity; entity_model's default (on) preserves this behavior.

- [ ] **Step 2: Run to verify status**

Run: `cd server/python && python3 -m pytest tests/codegen/test_abstract_conformance.py::test_entity_model_emits_abstract_base_and_concrete_inherits -v`
Expected: PASS already (regression guard). If it fails, entity_model regressed — investigate before proceeding.

- [ ] **Step 3: Add the config field for cross-port uniformity**

In `config.py`:

```python
@dataclass
class GenConfig:
    out_dir: str
    output_layout: str = "flat"
    emit_abstract_shapes: bool = True  # Python concretes subclass the abstract base model
```

Wire it into the Python CLI where `GenConfig(out_dir=...)` is constructed (pass through
from a `--emit-abstract-shapes` / `--no-emit-abstract-shapes` flag if the CLI exposes
codegen flags; otherwise leave the default). `entity_model` reads `ctx.config` only if it
later needs to suppress the abstract base; for now the default (on) keeps current behavior
and no code change to `entity_model` emission is required.

- [ ] **Step 4: Run the codegen suite**

Run: `cd server/python && python3 -m pytest tests/codegen -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/python/src/metaobjects/codegen/config.py server/python/tests/codegen/test_abstract_conformance.py
git commit -m "feat(python-codegen): emit_abstract_shapes config; keep abstract base model"
```

### Task 4.5: Python full suite + gate + merge

- [ ] **Step 1:** Run `cd server/python && python3 -m pytest tests -v` — green (codegen + conformance).
- [ ] **Step 2:** code-reviewer on the Python diff; fix.
- [ ] **Step 3:** code-simplifier on the Python diff; apply.
- [ ] **Step 4:** Re-run green. Merge forward to `main`.

---

## Unit 5 (optional) — TS config-knob parity

TS already honors the invariant (commit `39f2df9f`) and already emits a type-only
interface for abstract entities. Adding the `emitAbstractShapes` field to
`MetaobjectsGenConfig` (default **on**, normalized in `normalizeConfig`, threaded via
`renderContext`) makes the existing behavior explicit and toggleable for cross-port
uniformity. Low priority; do only if cross-port config symmetry is wanted.

- [ ] **Step 1:** Add `emitAbstractShapes?: boolean` to `MetaobjectsGenConfig` and `NormalizedMetaobjectsGenConfig`; default `true` in `normalizeConfig`; thread through `makeRenderContext`.
- [ ] **Step 2:** When `false`, the entity-file generator's value-object/abstract path returns no file for abstract entities. Add a test in `codegen-ts/test/instance-artifacts.test.ts` for both knob states.
- [ ] **Step 3:** `cd server/typescript && bun test`; commit.

---

## Self-Review Notes

- **Spec coverage:** Unit 0 = shared fixture; Units 1–4 cover the invariant (suppression) + DDL + knob for C#/Java/Kotlin/Python; Task 2.1 covers the `_isAbstract`→`isAbstract` unification; Unit 5 = optional TS parity. All spec sections map to a task.
- **Path/name verification:** Several tasks include a "confirm the emitted file name / property name" note — the implementer must read the specific generator/snapshot type before finalizing assertion strings (file-naming conventions weren't fully enumerated in the audit). These are flagged inline, not left as silent guesses.
- **Type consistency:** guard names are stable per port — C# `InstanceArtifacts.IsAbstract/EmitsInstanceArtifacts`; Java/Kotlin `GeneratorUtil.isAbstract` / `KotlinGenUtil.isAbstractEntity`; Python `is_abstract`/`emits_instance_artifacts`. Config field is `EmitAbstractShapes` (C#), `emitAbstractShapes` (Java/Kotlin arg, TS), `emit_abstract_shapes` (Python).
- **Gate discipline:** each unit ends with full-suite + code-reviewer + code-simplifier + merge-forward, per the established pre-merge rule.
