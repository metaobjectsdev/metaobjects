using System.Text.RegularExpressions;
using MetaObjects.Codegen;
using MetaObjects.Codegen.ApiDocs;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Keystone ACCURACY GATE (Phase 1 Task 1.5): proves the <see cref="CSharpApiModelBuilder"/>'s
/// documented SDK surface == what the REAL C# (EF Core) generators actually emit.
///
/// The builder enumerates symbol names via the <c>CSharpNaming</c> seam and gates inclusion
/// via each generator's static <c>AppliesTo(...)</c> predicate, so by construction documented
/// == generated. This test is the cross-check that holds that promise: it runs every real
/// generator into memory, then greps the generated C# for every documented symbol (FORWARD)
/// and confirms skip-shapes are not over-documented (INVERSE). The FORWARD assertions match
/// documented names against the independently generated source — never against the builder's
/// own strings.
///
/// Fixture (a test-local string, NOT the shared cross-port corpus): covers every skip branch —
///   • Author TABLE entity (pk, @required name, optional bio, field.enum status, @filterable
///     name) → MODEL/DATA_ACCESS/REST/FILTER/VALIDATION;
///   • Address value object referenced by an Author object-field → MODEL only (its POCO IS
///     emitted because it is referenced);
///   • BaseNode abstract entity → NO unit (no symbols);
///   • SummaryOutput responding template.prompt → PAYLOAD/PROMPT/OUTPUT_PARSER (ADR-0052 inbound);
///   • SummaryDoc template.output → RENDER + PAYLOAD (ADR-0052 outbound — no parser, ever).
/// </summary>
public sealed class CSharpApiDocsAccuracyTests
{
    private const string Project = "apidocs-fixture";

    private const string Model = """
    { "metadata.root": { "package": "blog", "children": [
      { "object.entity": { "name": "BaseNode", "abstract": true, "children": [
        { "field.long": { "name": "id" } }
      ]}},
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "city" } },
        { "field.string": { "name": "zip" } }
      ]}},
      { "object.entity": { "name": "Author", "children": [
        { "source.rdb": { "@table": "authors" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true, "@filterable": true } },
        { "field.string": { "name": "bio" } },
        { "field.enum":   { "name": "status", "@required": true, "@values": ["ACTIVE", "RETIRED"] } },
        { "field.object": { "name": "home", "@objectRef": "Address" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.projection": { "name": "AuthorSummary", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_author_summary" } },
        { "field.string": { "name": "name" } },
        { "field.long":   { "name": "tagCount" } }
      ]}},
      { "object.value": { "name": "SummaryPayload", "children": [
        { "field.string": { "name": "summary", "@required": true } }
      ]}},
      { "template.prompt": {
        "name": "SummaryOutput", "@payloadRef": "SummaryPayload", "@responseRef": "SummaryPayload",
        "@textRef": "blog/summary", "@format": "text", "@responseFormat": "json", "@promptStyle": "inline"
      }},
      { "template.output": {
        "name": "SummaryDoc", "@kind": "document", "@payloadRef": "SummaryPayload",
        "@textRef": "blog/summary", "@format": "json"
      }}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, GenConfig config) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = config,
    };

    // Run every real generator that contributes a documented symbol, into memory.
    private static (CSharpApiModel Model, string AllGenerated) BuildAndGenerate(string templateRoot)
    {
        var root = Load();
        var config = new GenConfig { OutDir = "/tmp/out", Namespace = "Blog" };
        var model = new CSharpApiModelBuilder(config).Build(root, Project);

        var ctx = Ctx(root, config);
        var sb = new System.Text.StringBuilder();
        void RunGen(IGenerator gen)
        {
            foreach (var f in gen.Generate(ctx)) sb.Append(f.Content).Append('\n');
        }
        RunGen(new EntityGenerator());
        RunGen(new DbContextGenerator());
        RunGen(new RoutesGenerator());
        RunGen(new FilterAllowlistGenerator());
        RunGen(new PayloadGenerator());
        RunGen(new OutputParserGenerator());
        RunGen(new OutputPromptGenerator());
        RunGen(new RenderHelperGenerator(templateRoot));
        return (model, sb.ToString());
    }

    private static string WriteTemplates()
    {
        var root = Path.Combine(Path.GetTempPath(), "csharp-apidocs-tpl-" + Guid.NewGuid().ToString("N"));
        var dir = Path.Combine(root, "blog");
        Directory.CreateDirectory(dir);
        // SummaryOutput → SummaryPayload { summary } — reference ONLY a present VO field so
        // the render-helper's build-time drift gate passes.
        File.WriteAllText(Path.Combine(dir, "summary.mustache"), "Summary: {{summary}}");
        return root;
    }

    /// <summary>Word-boundary identifier match: <paramref name="name"/> appears as a whole C# identifier.</summary>
    private static bool ContainsIdentifier(string haystack, string name) =>
        Regex.IsMatch(haystack, $@"(?<![A-Za-z0-9_]){Regex.Escape(name)}(?![A-Za-z0-9_])");

    /// <summary>
    /// DECLARATION match: <paramref name="name"/> is the name in a type OR member DECLARATION
    /// in the generated source — a type declaration (<c>class X</c> / <c>record X</c> /
    /// <c>enum X</c> / <c>static class X</c> / <c>interface X</c>, any modifiers allowed
    /// before the keyword), OR a member declaration whose name is immediately followed by a
    /// body/param-list/arrow (<c>X {</c> / <c>X(</c> / <c>X =&gt;</c>) — this covers the
    /// generated DbSet property (<c>public DbSet&lt;Author&gt; Authors { get; set; }</c>).
    /// A mere type *reference* (e.g. <c>DbSet&lt;X&gt;</c>, where <c>X</c> sits inside the
    /// generic args) does NOT satisfy this — that is the bug this guards: a
    /// documented-but-never-declared symbol slips past a bare-identifier match.
    /// </summary>
    private static bool ContainsDeclaration(string haystack, string name)
    {
        var n = Regex.Escape(name);
        // Type declaration: `class|record|enum|interface <Name>`.
        if (Regex.IsMatch(haystack, $@"\b(?:class|record|enum|interface)\s+{n}(?![A-Za-z0-9_])"))
            return true;
        // Member declaration: `<Name>` followed by a body `{`, a param list `(`, or `=>`.
        return Regex.IsMatch(haystack, $@"(?<![A-Za-z0-9_]){n}\s*(?:[{{(]|=>)");
    }

    // ------------------------------------------------------------------------

    [Fact]
    public void Fixture_loads_and_documents_the_expected_units()
    {
        var tpl = WriteTemplates();
        try
        {
            var (model, _) = BuildAndGenerate(tpl);
            var nodes = model.Units.Select(u => u.Node).OrderBy(n => n, StringComparer.Ordinal).ToList();
            // Author + Address + AuthorSummary (projection) + SummaryPayload + both halves of
            // the ADR-0052 split (SummaryOutput inbound prompt, SummaryDoc outbound output);
            // BaseNode (abstract) is absent.
            Assert.Equal(
                new[] { "Address", "Author", "AuthorSummary", "SummaryDoc", "SummaryOutput", "SummaryPayload" },
                nodes);
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Every_documented_type_name_appears_in_generated_csharp()
    {
        var tpl = WriteTemplates();
        try
        {
            var (model, all) = BuildAndGenerate(tpl);

            // The kinds whose symbol Name is an emitted C# identifier. REST is excluded
            // (it documents "VERB path", checked separately).
            var typeKinds = new HashSet<ApiSymbolKind>
            {
                ApiSymbolKind.Model, ApiSymbolKind.DataAccess, ApiSymbolKind.Validation,
                ApiSymbolKind.Filter, ApiSymbolKind.Payload, ApiSymbolKind.Render,
                ApiSymbolKind.Prompt, ApiSymbolKind.OutputParser,
            };

            var checkd = 0;
            foreach (var unit in model.Units)
                foreach (var sym in unit.Symbols)
                {
                    if (!typeKinds.Contains(sym.Kind)) continue;
                    Assert.True(ContainsDeclaration(all, sym.Name),
                        $"documented {sym.Kind} symbol '{sym.Name}' (unit {unit.Node}) was NOT found as a "
                        + "DECLARATION in the generated C# — the builder over-documents (a mere reference does "
                        + "not count) or names off-seam.");
                    checkd++;
                }
            Assert.True(checkd >= 8, $"expected to cross-check several documented type symbols; saw {checkd}");
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Every_rest_symbol_maps_to_a_real_route_registration()
    {
        var tpl = WriteTemplates();
        try
        {
            var (model, all) = BuildAndGenerate(tpl);
            var author = model.Units.Single(u => u.Node == "Author");
            var rest = author.Symbols.Where(s => s.Kind == ApiSymbolKind.Rest).ToList();
            // 5 CRUD verbs (GET list, GET id, POST, PATCH, PUT, DELETE = 6) on a single-PK
            // writable entity with no M:N.
            Assert.Equal(6, rest.Count);
            foreach (var sym in rest)
            {
                var parts = sym.Name.Split(' ', 2);
                Assert.Equal(2, parts.Length);
                var verb = parts[0];
                var path = parts[1];
                Assert.StartsWith("/api/authors", path);
                // The generated routes register MapGet/MapPost/MapPatch/MapPut/MapDelete with
                // the exact relative path (prefix + "/<path-after-/api>"). Assert the verb's
                // Map<Verb> call carries the route remainder.
                var remainder = path["/api".Length..]; // "/authors" | "/authors/{id}"
                var mapCall = verb switch
                {
                    "GET" => "MapGet(prefix + \"" + remainder + "\"",
                    "POST" => "MapPost(prefix + \"" + remainder + "\"",
                    "PATCH" => "MapPatch(prefix + \"" + remainder + "\"",
                    "PUT" => "MapPut(prefix + \"" + remainder + "\"",
                    "DELETE" => "MapDelete(prefix + \"" + remainder + "\"",
                    _ => throw new Xunit.Sdk.XunitException($"unexpected verb {verb}"),
                };
                Assert.True(all.Contains(mapCall),
                    $"REST symbol '{sym.Name}' has no matching route registration; expected: {mapCall}");
            }
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Value_object_is_documented_as_model_only()
    {
        var tpl = WriteTemplates();
        try
        {
            var (model, all) = BuildAndGenerate(tpl);
            var address = model.Units.Single(u => u.Node == "Address");
            Assert.All(address.Symbols, s => Assert.Equal(ApiSymbolKind.Model, s.Kind));
            // No AddressController/Routes/FilterAllowlist generated either — even the names absent.
            Assert.False(ContainsIdentifier(all, "AddressRoutes"));
            Assert.False(ContainsIdentifier(all, "AddressFilterAllowlist"));
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Projection_is_documented_as_read_model_with_readonly_dbset_no_write_surface()
    {
        var tpl = WriteTemplates();
        try
        {
            var (model, all) = BuildAndGenerate(tpl);
            var summary = model.Units.Single(u => u.Node == "AuthorSummary");

            // A view-kind object.projection → a read-model unit with a read-only DbSet +
            // read routes, but NO write surfaces (no Validation / FilterAllowlist). The
            // DbSet + read routes ARE generated for a projection (DbView != null), so the
            // builder must document them — the bug was the `if (entity)` gate hiding them.
            Assert.Equal("projection", summary.Kind);
            var kinds = summary.Symbols.Select(s => s.Kind).ToHashSet();
            Assert.Contains(ApiSymbolKind.Model, kinds);
            Assert.Contains(ApiSymbolKind.DataAccess, kinds);
            Assert.DoesNotContain(ApiSymbolKind.Validation, kinds);
            Assert.DoesNotContain(ApiSymbolKind.Filter, kinds);

            // Forward-confirm the documented DbSet is really declared on the AppDbContext...
            var dbSet = summary.Symbols.Single(s => s.Kind == ApiSymbolKind.DataAccess);
            Assert.True(ContainsDeclaration(all, dbSet.Name),
                $"documented projection DbSet '{dbSet.Name}' is not declared in the generated C#");

            // ...every documented REST verb maps to a real route registration (read verbs
            // only — a read-only projection generates no POST/PATCH/PUT/DELETE)...
            foreach (var sym in summary.Symbols.Where(s => s.Kind == ApiSymbolKind.Rest))
            {
                var parts = sym.Name.Split(' ', 2);
                Assert.Equal("GET", parts[0]);
                var remainder = parts[1]["/api".Length..];
                Assert.True(all.Contains("MapGet(prefix + \"" + remainder + "\""),
                    $"documented projection REST '{sym.Name}' has no matching MapGet registration");
            }

            // ...and NO filter allowlist CLASS is declared for the projection (the builder
            // documents no FILTER symbol, matching FilterAllowlistGenerator skipping it).
            Assert.False(ContainsDeclaration(all, "AuthorSummaryFilterAllowlist"));
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Abstract_object_is_not_documented()
    {
        var tpl = WriteTemplates();
        try
        {
            var (model, _) = BuildAndGenerate(tpl);
            Assert.DoesNotContain(model.Units, u => u.Node == "BaseNode");
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Responding_prompt_documents_payload_response_format_and_parser()
    {
        // ADR-0052: the INBOUND symbols belong to the responding prompt. The documented
        // Payload is the @responseRef shape — what the parser above it actually returns.
        var tpl = WriteTemplates();
        try
        {
            var (model, _) = BuildAndGenerate(tpl);
            var summary = model.Units.Single(u => u.Node == "SummaryOutput");
            var kinds = summary.Symbols.Select(s => s.Kind).ToHashSet();
            Assert.Equal(
                new HashSet<ApiSymbolKind>
                {
                    ApiSymbolKind.Payload, ApiSymbolKind.Prompt, ApiSymbolKind.OutputParser,
                },
                kinds);
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }

    [Fact]
    public void Output_template_documents_render_and_its_payload_only()
    {
        // The other half of the ADR-0052 split, and the control for it: `template.output`
        // is OUTBOUND ONLY. It documents its render helper and the payload record that
        // helper binds — and nothing that reads a reply: no parser, no response-format
        // fragment. api-docs claiming an OutputParser here would document a symbol codegen
        // no longer emits.
        //
        // PAYLOAD is asserted PRESENT because PayloadGenerator emits `<VO>.payload.cs` for
        // this template. Dropping the symbol left that record emitted but documented
        // nowhere, contradicting PayloadGenerator's own "AppliesTo is the SINGLE SOURCE OF
        // TRUTH the api-docs builder shares" contract.
        var tpl = WriteTemplates();
        try
        {
            var (model, _) = BuildAndGenerate(tpl);
            var doc = model.Units.Single(u => u.Node == "SummaryDoc");
            var kinds = doc.Symbols.Select(s => s.Kind).ToHashSet();
            Assert.Equal(
                new HashSet<ApiSymbolKind> { ApiSymbolKind.Render, ApiSymbolKind.Payload },
                kinds);
        }
        finally { Directory.Delete(tpl, recursive: true); }
    }
}
