# Cross-Port templateGenerator — Plan 2: C# Port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `TemplateGenerator` in the C# port + a conformance adapter that runs the Plan-0 corpus byte-equivalently.

**Architecture:** Mirrors Plan 0 (TS) and Plan 1 (Python) in idiomatic C#. Static `TemplateGenerator.Create(...)` factory returns an object satisfying the existing `IGenerator` interface at `MetaObjects.Codegen.IGenerator`. Walk callback returns `IEnumerable<(object data, string outputPath)>`; the factory renders the shared Mustache template via `MetaObjects.Render.Renderer.Render()` and emits `IEnumerable<EmittedFile>`.

**Tech Stack:** C# (.NET 8) / xUnit / MetaObjects.Render (existing) / MetaObjects.Codegen (existing).

**Scope boundary:** C# factory + C# conformance adapter only. Java (Plan 3) follows.

---

## File Structure

**New:**
- `server/csharp/MetaObjects.Codegen/Generators/TemplateGenerator.cs` — the factory + walk-result record
- `server/csharp/MetaObjects.Codegen.Tests/TemplateGeneratorTests.cs` — unit tests
- `server/csharp/MetaObjects.Render.Tests/TemplateGeneratorConformanceTests.cs` — conformance adapter

**No modification** to existing files (no CLI registration changes, no exports change). The factory is consumable directly.

---

## Task 1: Factory + walk-result record + unit tests (TDD)

**Files:**
- Create: `server/csharp/MetaObjects.Codegen/Generators/TemplateGenerator.cs`
- Create: `server/csharp/MetaObjects.Codegen.Tests/TemplateGeneratorTests.cs`

- [ ] **Step 1: Write the factory + walk-result record**

```csharp
// TemplateGenerator — C# port of the TS rc.12 templateGenerator() factory.
//
// Walks the loaded MetaRoot via a caller-supplied walk callback, renders the
// shared Mustache template via MetaObjects.Render, and emits EmittedFile per
// walk entry. Same IGenerator interface as the hand-coded generators.
//
// Design: spec/design-docs/2026-05-28-cross-port-template-generator.md.
// Cross-port byte-equivalence verified via fixtures/render-conformance/template-generator/.

using MetaObjects.Render;
using MetaObjects.Shared;

namespace MetaObjects.Codegen.Generators;

public record TemplateWalkResult(object Data, string OutputPath);

public static class TemplateGenerator
{
    public static IGenerator Create(
        string name,
        string template,
        Func<MetaRoot, IEnumerable<TemplateWalkResult>> walk,
        IProvider provider,
        string format = "text")
    {
        return new TemplateGeneratorImpl(name, template, walk, provider, format);
    }

    private sealed class TemplateGeneratorImpl : IGenerator
    {
        private readonly string _template;
        private readonly Func<MetaRoot, IEnumerable<TemplateWalkResult>> _walk;
        private readonly IProvider _provider;
        private readonly string _format;

        public string Name { get; }

        public TemplateGeneratorImpl(
            string name, string template,
            Func<MetaRoot, IEnumerable<TemplateWalkResult>> walk,
            IProvider provider, string format)
        {
            Name = name;
            _template = template;
            _walk = walk;
            _provider = provider;
            _format = format;
        }

        public IEnumerable<EmittedFile> Generate(GenContext ctx)
        {
            foreach (var entry in _walk(ctx.Root))
            {
                var request = new RenderRequest
                {
                    Ref = _template,
                    Payload = entry.Data,
                    Provider = _provider,
                    Format = _format,
                };
                var content = Renderer.Render(request);
                yield return new EmittedFile(entry.OutputPath, content);
            }
        }
    }
}
```

- [ ] **Step 2: Verify imports + RenderRequest property names**

Run: `cd <repo-root>/server/csharp && grep -E "class RenderRequest|public.*(Template|Ref|Payload|Provider|Format)" MetaObjects.Render/RenderRequest.cs 2>&1 | head -10`

Expected: confirm field/property names match (`Ref`, `Payload`, `Provider`, `Format`). If names differ, update the factory accordingly.

- [ ] **Step 3: Write the unit tests (per-entity + aggregator + format)**

```csharp
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Object;
using MetaObjects.Core.Field;
using MetaObjects.Render;
using MetaObjects.Shared;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class TemplateGeneratorTests
{
    private static MetaRoot BuildRoot()
    {
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "test");
        var post = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
        post.AddChild(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
        post.AddChild(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
        root.AddChild(post);
        root.Freeze();
        return root;
    }

    private static GenContext MakeCtx(MetaRoot root) => new GenContext
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        Warn = _ => { },
    };

    [Fact]
    public void PerEntityWalkEmitsOneFilePerEntity()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/hello"] = "Hello {{name}}!\n",
        });
        var root = BuildRoot();
        var gen = TemplateGenerator.Create(
            name: "hello",
            template: "custom/hello",
            provider: provider,
            walk: r => r.Objects().Select(e =>
                new TemplateWalkResult(new { name = e.Name }, $"{e.Name}.txt")));
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.Single(files);
        Assert.Equal("Post.txt", files[0].Path);
        Assert.Equal("Hello Post!\n", files[0].Content);
    }

    [Fact]
    public void AggregatorWalkEmitsSingleFileFromAllEntities()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/index"] = "Entities:\n{{#entities}}- {{name}}\n{{/entities}}",
        });
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "test");
        var post = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
        root.AddChild(post);
        var comment = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Comment");
        root.AddChild(comment);
        root.Freeze();

        var gen = TemplateGenerator.Create(
            name: "index",
            template: "custom/index",
            provider: provider,
            walk: r => new[]
            {
                new TemplateWalkResult(
                    new { entities = r.Objects().Select(e => new { name = e.Name }).ToList() },
                    "index.txt"),
            });
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.Single(files);
        Assert.Equal("index.txt", files[0].Path);
        Assert.Equal("Entities:\n- Post\n- Comment\n", files[0].Content);
    }

    [Fact]
    public void FormatTextDoesNotEscapeHtml()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/raw"] = "{{snippet}}\n",
        });
        var root = BuildRoot();
        var gen = TemplateGenerator.Create(
            name: "raw-text",
            template: "custom/raw",
            provider: provider,
            format: "text",
            walk: _ => new[]
            {
                new TemplateWalkResult(new { snippet = "<p>hi</p>" }, "out.txt"),
            });
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.Equal("<p>hi</p>\n", files[0].Content);
    }

    [Fact]
    public void FormatHtmlEscapesHtmlInPayload()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/raw"] = "{{snippet}}\n",
        });
        var root = BuildRoot();
        var gen = TemplateGenerator.Create(
            name: "raw-html",
            template: "custom/raw",
            provider: provider,
            format: "html",
            walk: _ => new[]
            {
                new TemplateWalkResult(new { snippet = "<p>hi</p>" }, "out.html"),
            });
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.NotEqual("<p>hi</p>\n", files[0].Content);
        Assert.True(files[0].Content.Contains("&lt;") || files[0].Content.Contains("&#60;"));
    }
}
```

- [ ] **Step 4: Build + run**

Run: `cd <repo-root>/server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --filter "FullyQualifiedName~TemplateGeneratorTests" 2>&1 | tail -15`

Expected: 4 tests pass.

If a test fails — common causes:
- "namespace X does not exist": missing using or incorrect namespace. Open `MetaObjects.Codegen/Generator.cs` to confirm EmittedFile/GenContext signatures, then fix imports.
- "TypeId constructor takes...": confirm the TypeId record's exact signature at `MetaObjects.Shared/`.
- HTML escape failing: render format may use different escape sequence (`&#x3c;` vs `&lt;`). Verify via the Render conformance corpus.

- [ ] **Step 5: Commit**

```bash
cd <repo-root>
git add server/csharp/MetaObjects.Codegen/Generators/TemplateGenerator.cs \
        server/csharp/MetaObjects.Codegen.Tests/TemplateGeneratorTests.cs
git commit -m "feat(cs-codegen): TemplateGenerator factory + unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Conformance adapter

**Files:**
- Create: `server/csharp/MetaObjects.Render.Tests/TemplateGeneratorConformanceTests.cs`

- [ ] **Step 1: Write the conformance adapter**

```csharp
// Cross-port byte-equivalence harness for the C# TemplateGenerator factory.
//
// Mirrors the TS reference adapter:
// server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts
//
// Fixture format: fixtures/render-conformance/template-generator/README.md

using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Object;
using MetaObjects.Core.Field;
using MetaObjects.Render;
using MetaObjects.Shared;
using Xunit;

namespace MetaObjects.Render.Tests;

public class TemplateGeneratorConformanceTests
{
    private static readonly Dictionary<string, string> FieldTypeMap = new()
    {
        ["string"] = FIELD_SUBTYPE_STRING,
        ["long"] = FIELD_SUBTYPE_LONG,
        ["int"] = FIELD_SUBTYPE_INT,
        ["double"] = FIELD_SUBTYPE_DOUBLE,
        ["boolean"] = FIELD_SUBTYPE_BOOLEAN,
        ["date"] = FIELD_SUBTYPE_DATE,
    };

    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "render-conformance", "template-generator")))
        {
            var parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/render-conformance/template-generator not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "render-conformance", "template-generator");
    }

    public static IEnumerable<object[]> Fixtures()
    {
        var corpus = CorpusRoot();
        foreach (var dir in Directory.GetDirectories(corpus).OrderBy(d => d, StringComparer.Ordinal))
        {
            if (Path.GetFileName(dir).StartsWith("fixture-"))
                yield return new object[] { Path.GetFileName(dir), dir };
        }
    }

    private static MetaRoot BuildRoot(JsonElement meta)
    {
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "conformance");
        foreach (var e in meta.GetProperty("entities").EnumerateArray())
        {
            var obj = new MetaObject(
                new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY),
                e.GetProperty("name").GetString()!);
            foreach (var f in e.GetProperty("fields").EnumerateArray())
            {
                var typeStr = f.GetProperty("type").GetString()!;
                if (!FieldTypeMap.TryGetValue(typeStr, out var subtype))
                    throw new InvalidOperationException($"Unknown field type '{typeStr}'");
                obj.AddChild(new MetaField(
                    new TypeId(TYPE_FIELD, subtype),
                    f.GetProperty("name").GetString()!));
            }
            root.AddChild(obj);
        }
        root.Freeze();
        return root;
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void TemplateGeneratorConformance(string fixtureName, string fixtureDir)
    {
        var meta = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtureDir, "meta.json"))).RootElement;
        var templateBody = File.ReadAllText(Path.Combine(fixtureDir, "template.mustache"));
        var walkJson = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtureDir, "walk.json"))).RootElement;

        var walkEntries = walkJson.EnumerateArray().Select(w => new
        {
            Entity = w.TryGetProperty("entity", out var e) ? e.GetString() : null,
            Data = (object)JsonElementToObject(w.GetProperty("data")),
            OutputPath = w.GetProperty("outputPath").GetString()!,
        }).ToList();

        var root = BuildRoot(meta);
        var byName = root.Objects().Select(o => o.Name).ToHashSet();
        foreach (var w in walkEntries)
        {
            if (w.Entity != null && !byName.Contains(w.Entity))
                throw new InvalidOperationException($"walk.json references unknown entity '{w.Entity}'");
        }

        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["conformance/template"] = templateBody,
        });
        var gen = TemplateGenerator.Create(
            name: fixtureName,
            template: "conformance/template",
            provider: provider,
            format: meta.GetProperty("format").GetString()!,
            walk: _ => walkEntries.Select(w => new TemplateWalkResult(w.Data, w.OutputPath)));

        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
            Warn = _ => { },
        };
        var files = gen.Generate(ctx).ToList();

        // Output paths match walk.json
        var emittedPaths = files.Select(f => f.Path).OrderBy(p => p).ToList();
        var expectedPaths = walkEntries.Select(w => w.OutputPath).OrderBy(p => p).ToList();
        Assert.Equal(expectedPaths, emittedPaths);

        // Byte-equivalent expected output
        var expectedDir = Path.Combine(fixtureDir, "expected");
        foreach (var w in walkEntries)
        {
            var expectedFile = Path.Combine(expectedDir, w.OutputPath);
            Assert.True(File.Exists(expectedFile), $"missing expected/{w.OutputPath}");
            var expected = File.ReadAllText(expectedFile);
            var actual = files.First(f => f.Path == w.OutputPath).Content;
            Assert.Equal(expected, actual);
        }
    }

    // Convert a System.Text.Json JsonElement to a dynamic object the Mustache renderer can iterate.
    private static object JsonElementToObject(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                var dict = new Dictionary<string, object?>();
                foreach (var p in el.EnumerateObject())
                    dict[p.Name] = JsonElementToObject(p.Value);
                return dict;
            case JsonValueKind.Array:
                return el.EnumerateArray().Select(JsonElementToObject).ToList();
            case JsonValueKind.String: return el.GetString()!;
            case JsonValueKind.Number:
                if (el.TryGetInt64(out var l)) return l;
                return el.GetDouble();
            case JsonValueKind.True: return true;
            case JsonValueKind.False: return false;
            case JsonValueKind.Null: return null!;
            default: throw new InvalidOperationException($"Unhandled JsonValueKind {el.ValueKind}");
        }
    }
}
```

- [ ] **Step 2: Run conformance**

Run: `cd <repo-root>/server/csharp && dotnet test MetaObjects.Render.Tests/MetaObjects.Render.Tests.csproj --filter "FullyQualifiedName~TemplateGeneratorConformance" 2>&1 | tail -15`

Expected: 3 tests pass (fixture-001, fixture-002, fixture-003).

If byte-equivalence fails: check whether C#'s Mustache renderer (Stubble) handles `{{#section}}` whitespace identically to Bun's Mustache impl. Both should be spec-compliant; differences are escaping nuances or `lambda` formatting. Look at the actual vs expected diff in the assertion — often a trailing newline or whitespace issue. If a real spec-corner-case difference: file a render-conformance gap (don't tweak the C# fixture; the cross-port byte equivalence is the whole point).

- [ ] **Step 3: Commit**

```bash
cd <repo-root>
git add server/csharp/MetaObjects.Render.Tests/TemplateGeneratorConformanceTests.cs
git commit -m "test(cs-conformance): TemplateGenerator cross-port byte-equivalence harness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Regression check

- [ ] **Step 1: Run the full C# test surface**

Run: `cd <repo-root>/server/csharp && dotnet test 2>&1 | tail -8`

Expected: all tests pass. New tests add: 4 (TemplateGeneratorTests) + 3 (TemplateGeneratorConformanceTests).

- [ ] **Step 2: No commit** (read-only verification)

---

## Self-Review

**1. Spec coverage:**
- Per-port factory contract → Task 1 (matches TS opt names + C# idiom)
- Conformance via shared declarative fixtures → Task 2 (parametrized over Plan-0 corpus via `[Theory] [MemberData]`)
- Walk patterns → Task 2 (one parametrized test that handles all 3 fixtures)
- Render integration → factory uses existing `Renderer.Render()` (no new render code)
- IGenerator integration → factory satisfies the existing IGenerator interface (no interface changes)
- CLI integration → out of scope; default-generator list in `GenCommand.DefaultGenerators()` not touched (adopters wire `TemplateGenerator.Create(...)` themselves)

**2. Placeholder scan:** Searched for "TBD", "TODO", "fill in", "implement later". None present. Every step has executable content or a runnable command.

**3. Type consistency:**
- `TemplateWalkResult(Data, OutputPath)` — same shape as Python's `{"data", "output_path"}` and TS `{data, outputPath}`.
- `TemplateGenerator.Create(name, template, walk, provider, format)` — same kwargs as Python factory + TS factory.
- `JsonElementToObject` is needed because Mustache renderer expects `Dictionary<string, object>` / `List<object>`, not raw `JsonElement` — this is a C#-specific boundary at the conformance adapter only, not in the factory.

No drift.
