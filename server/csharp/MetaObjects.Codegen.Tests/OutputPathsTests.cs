// R39: generated output paths are keyed by metadata package. Every per-object generator writes
// `<package segments>/<file>`, so two same-named objects in two packages are two files. Since
// rc.19 R65 the C# namespace follows the package too, so a same-namespace clash takes an explicit
// mapping of both packages onto one namespace; the claim registry refuses it, naming both.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class OutputPathsTests
{
    private static string Note(string pkg, string field) => $$"""
        { "metadata.root": { "package": "{{pkg}}", "children": [
          { "object.entity": { "name": "Note", "children": [
            { "source.rdb": { "@table": "{{pkg.Replace("::", "_")}}_notes" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "{{field}}" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } } ] } }
        """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Note("acme::alpha", "alphaText"), id: "a.json"),
            new InMemoryStringSource(Note("acme::beta", "betaText"), id: "b.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, bool mapped) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.Generated",
            PackageNamespaces = mapped ? new() { ["acme::alpha"] = "Acme.Alpha", ["acme::beta"] = "Acme.Beta" } : new(),
        },
    };

    /// <summary>R65: a real same-namespace clash — both packages mapped, explicitly, onto one namespace.</summary>
    private static GenContext OneNamespace(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.Generated",
            PackageNamespaces = new() { ["acme::alpha"] = "Acme.Shared", ["acme::beta"] = "Acme.Shared" },
        },
    };

    [Fact]
    public void A_file_is_written_under_its_objects_package()
    {
        var root = Load();
        Assert.Equal("acme/alpha/Note.g.cs", OutputPaths.Of(root.Objects().First(o => o.ResolutionKey() == "acme::alpha::Note"), "Note.g.cs"));
    }

    [Fact]
    public void Two_same_named_objects_in_two_packages_are_two_files_from_every_per_object_generator()
    {
        var ctx = Ctx(Load(), mapped: true);
        foreach (var (gen, file) in new (IGenerator, string)[]
                 {
                     (new EntityGenerator(), "Note.g.cs"), (new NamesGenerator(), "NoteNames.g.cs"),
                     (new FilterAllowlistGenerator(), "NoteFilterAllowlist.g.cs"),
                 })
        {
            var paths = gen.Generate(ctx).Select(f => f.Path).Where(p => p.EndsWith("/" + file)).Order().ToList();
            Assert.Equal([$"acme/alpha/{file}", $"acme/beta/{file}"], paths);
        }
    }

    [Fact]
    public void One_namespace_still_refuses_the_pair_with_PackageNamespaces_as_the_remedy()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => new EntityGenerator().Generate(OneNamespace(Load())).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("GenConfig.PackageNamespaces", ex.Message);
    }

    // rc.19 fix round (I2): package-keyed paths mean two same-named objects no longer collide on one
    // output file, so only a claim stops a duplicate type: every generator that emits a class claims
    // its name where it emits it, and the filter allowlist lands in its entity's namespace.

    private static List<string> CompileErrors(IEnumerable<EmittedFile> files)
    {
        var sources = files.ToList();
        var comp = CSharpCompilation.Create("paths_" + Guid.NewGuid().ToString("N"),
            sources.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))),
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
    }

    [Fact]
    public void Two_packages_mapped_apart_compile_entity_names_and_filter_allowlist_together()
    {
        var ctx = Ctx(Load(), mapped: true);
        var files = new EntityGenerator().Generate(ctx).Concat(new NamesGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx)).ToList();
        Assert.Contains("namespace Acme.Alpha;", Assert.Single(files, f => f.Path == "acme/alpha/NoteFilterAllowlist.g.cs").Content);
        var errors = CompileErrors(files);
        Assert.True(errors.Count == 0, "generated code should compile, but got:\n" + string.Join("\n", errors));
    }

    public static TheoryData<string> ClassEmitters => new() { "names", "filter-allowlist" };

    [Theory]
    [MemberData(nameof(ClassEmitters))]
    public void A_duplicate_in_one_namespace_is_a_named_refusal_not_CS0101(string generator)
    {
        IGenerator gen = generator == "names" ? new NamesGenerator() : new FilterAllowlistGenerator();
        var ex = Assert.Throws<InvalidOperationException>(() => gen.Generate(OneNamespace(Load())).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("acme::alpha::Note", ex.Message);
        Assert.Contains("acme::beta::Note", ex.Message);
        Assert.Contains("GenConfig.PackageNamespaces", ex.Message);
    }

    private static string Prompt(string pkg) => $$"""
        { "metadata.root": { "package": "{{pkg}}", "children": [
          { "object.value": { "name": "Ask{{pkg.Replace("::", "")}}", "children": [ { "field.string": { "name": "q" } } ] } },
          { "object.value": { "name": "Detail{{pkg.Replace("::", "")}}", "children": [ { "field.string": { "name": "d" } } ] } },
          { "object.value": { "name": "Answer{{pkg.Replace("::", "")}}", "children": [ { "field.string": { "name": "a" } },
              { "field.object": { "name": "detail", "@objectRef": "Detail{{pkg.Replace("::", "")}}" } } ] } },
          { "template.prompt": { "name": "Ask", "@payloadRef": "Ask{{pkg.Replace("::", "")}}", "@responseRef": "Answer{{pkg.Replace("::", "")}}",
              "@textRef": "ask/x", "@format": "text", "@responseFormat": "json" } } ] } }
        """;

    public static TheoryData<string> TemplateEmitters => new() { "render-helper", "output-parser", "output-prompt", "extractor" };

    [Theory]
    [MemberData(nameof(TemplateEmitters))]
    public void Two_same_named_templates_in_two_packages_are_a_named_refusal(string generator)
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Prompt("acme::alpha"), id: "a.json"),
            new InMemoryStringSource(Prompt("acme::beta"), id: "b.json")]);
        Assert.Empty(r.Errors);
        var templates = Directory.CreateTempSubdirectory("mo-paths-tmpl-").FullName;
        Directory.CreateDirectory(Path.Combine(templates, "ask"));
        File.WriteAllText(Path.Combine(templates, "ask", "x.mustache"), "{{q}}");
        IGenerator gen = generator switch
        {
            "render-helper" => new RenderHelperGenerator(templates),
            "output-parser" => new OutputParserGenerator(),
            "output-prompt" => new OutputPromptGenerator(),
            _ => new ExtractorGenerator(),
        };
        // The template tier always emits into GenConfig.Namespace, so mapping the packages cannot help.
        var ex = Assert.Throws<InvalidOperationException>(() => gen.Generate(Ctx(r.Root, mapped: true)).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("rename one", ex.Message);
        Assert.DoesNotContain("PackageNamespaces", ex.Message);
    }

    private static string Report(string pkg) => $$"""
        { "metadata.root": { "package": "{{pkg}}", "children": [
          { "object.entity": { "name": "Invoice", "children": [
            { "source.rdb": { "@table": "{{pkg.Replace("::", "_")}}_invoices" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "label", "@maxLength": 40 } },
            { "identity.primary": { "@fields": "id" } },
            { "dimension.attribute": { "name": "label", "@of": "Invoice.label" } },
            { "measure.aggregate": { "name": "lines", "@agg": "count", "@of": "Invoice.id" } } ] } },
          { "object.report": { "name": "InvoiceTotals", "@from": "Invoice", "@dimensions": ["label"], "@measures": ["lines"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_{{pkg.Replace("::", "_")}}_invoice_totals" } } ] } } ] } }
        """;

    [Fact]
    public void Two_same_named_reports_in_two_packages_each_get_an_export_in_their_own_namespace()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Report("acme::alpha"), id: "a.json"),
            new InMemoryStringSource(Report("acme::beta"), id: "b.json")]);
        Assert.Empty(r.Errors);
        var files = new ReportExportGenerator().Generate(Ctx(r.Root, mapped: false)).ToList();
        Assert.Contains("namespace Acme.Alpha;", Assert.Single(files, f => f.Path == "acme/alpha/InvoiceTotalsExport.g.cs").Content);
        Assert.Contains("namespace Acme.Beta;", Assert.Single(files, f => f.Path == "acme/beta/InvoiceTotalsExport.g.cs").Content);
    }

    [Fact]
    public void Two_same_named_reports_mapped_onto_one_namespace_are_a_named_refusal_from_the_export()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Report("acme::alpha"), id: "a.json"),
            new InMemoryStringSource(Report("acme::beta"), id: "b.json")]);
        Assert.Empty(r.Errors);
        var ex = Assert.Throws<InvalidOperationException>(() => new ReportExportGenerator().Generate(OneNamespace(r.Root)).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("InvoiceTotalsExport", ex.Message);
    }

    // rc.19 fix round (M1): the path half the GetFileName-based tests stopped pinning. Every
    // per-object generator writes its object's file under the object's package directory.
    public static TheoryData<string, string> PerObjectFiles => new()
    {
        { "entity", "acme/alpha/Note.g.cs" },
        { "names", "acme/alpha/NoteNames.g.cs" },
        { "filter-allowlist", "acme/alpha/NoteFilterAllowlist.g.cs" },
        { "routes", "acme/alpha/NoteRoutes.g.cs" },
        { "output-parser", "acme/alpha/Ask.response.cs" },
        { "output-prompt", "acme/alpha/Ask.responseFormat.cs" },
        { "render-helper", "acme/alpha/Ask.render.cs" },
        { "extractor", "acme/alpha/AskExtractor.cs" },
        { "report-export", "acme/alpha/InvoiceTotalsExport.g.cs" },
    };

    [Theory]
    [MemberData(nameof(PerObjectFiles))]
    public void Every_per_object_generator_writes_under_its_objects_package(string generator, string path)
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Note("acme::alpha", "alphaText"), id: "n.json"),
            new InMemoryStringSource(Prompt("acme::alpha"), id: "p.json"),
            new InMemoryStringSource(Report("acme::alpha"), id: "r.json")]);
        Assert.Empty(r.Errors);
        var templates = Directory.CreateTempSubdirectory("mo-paths-tmpl-").FullName;
        Directory.CreateDirectory(Path.Combine(templates, "ask"));
        File.WriteAllText(Path.Combine(templates, "ask", "x.mustache"), "{{q}}");
        IGenerator gen = generator switch
        {
            "entity" => new EntityGenerator(),
            "names" => new NamesGenerator(),
            "filter-allowlist" => new FilterAllowlistGenerator(),
            "routes" => new RoutesGenerator(),
            "output-parser" => new OutputParserGenerator(),
            "output-prompt" => new OutputPromptGenerator(),
            "render-helper" => new RenderHelperGenerator(templates),
            "extractor" => new ExtractorGenerator(),
            _ => new ReportExportGenerator(),
        };
        var paths = gen.Generate(Ctx(r.Root, mapped: false)).Select(f => f.Path).ToList();
        Assert.Contains(path, paths);
    }
}
