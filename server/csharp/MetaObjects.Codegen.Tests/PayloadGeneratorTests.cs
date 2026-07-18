using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// PayloadGenerator emission tests. Mirrors OutputParserGeneratorTests' shape (file-per-
/// template.output, GenContext wiring) plus the regression this generator specifically needed:
/// a template.output declared in a NAMED package with a BARE @payloadRef. ADR-0042 resolves
/// that bare attr to its fully-qualified form (MetaData.Attr() returns "pkg::Name", not the
/// literal string the author typed) — PayloadCodegen.EmitRecord's FindObject only matched a
/// bare short name, so the top-level payload record (and its file) silently emitted empty.
/// Nested @objectRef fields never hit this because FieldType already stripped them; only the
/// generator's own top-level payloadRef was unstripped.
/// </summary>
public sealed class PayloadGeneratorTests
{
    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "payload-gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Emits_no_files_when_no_template_output_nodes()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.prompt": { "name": "promptOnly", "@payloadRef": "Payload", "@textRef": "p/x", "@format": "text" } }
        ]}}
        """;
        var files = new PayloadGenerator().Generate(Ctx(Load(m))).ToList();
        Assert.Empty(files);
    }

    // Regression: a template.output in a NAMED package (not the default/root package) with a
    // BARE @payloadRef. Before the fix, this emitted a file with a header comment and NOTHING
    // else — no record, because FindObject's bare-name match failed against the FQN attr value.
    [Fact]
    public void Emits_full_record_for_bare_payloadRef_in_a_named_package()
    {
        const string m = """
        { "metadata.root": { "package": "acme::intake", "children": [
          { "object.value": { "name": "NoteEntry", "children": [
            { "field.string": { "name": "value" } },
            { "field.string": { "name": "reasoning" } }
          ]}},
          { "object.value": { "name": "ClassificationResponse", "children": [
            { "field.string":  { "name": "documentType" } },
            { "field.decimal": { "name": "confidence" } },
            { "field.object":  { "name": "note", "@objectRef": "NoteEntry" } }
          ]}},
          { "template.output": { "name": "ClassificationResponseTemplate",
            "@payloadRef": "ClassificationResponse", "@textRef": "ai/classification-response", "@format": "text" } }
        ]}}
        """;
        var files = new PayloadGenerator().Generate(Ctx(Load(m))).ToList();

        var file = Assert.Single(files);
        Assert.Equal("ClassificationResponse.payload.cs", file.Path);
        Assert.Contains("public sealed record ClassificationResponse", file.Content);
        Assert.Contains("public required string documentType { get; init; }", file.Content);
        Assert.Contains("public required double confidence { get; init; }", file.Content);
        Assert.Contains("public required NoteEntry note { get; init; }", file.Content);
        Assert.Contains("public sealed record NoteEntry", file.Content);
        Assert.Contains("public required string value { get; init; }", file.Content);
        // The FQN must not leak into the file name or the record/type names.
        Assert.DoesNotContain("acme::intake::", file.Content);
        Assert.DoesNotContain("::", file.Path);
    }

    [Fact]
    public void Emits_one_file_per_template_output_with_expected_path_and_class()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "AlphaPayload", "children": [ { "field.string": { "name": "name" } } ] } },
          { "object.value": { "name": "BetaPayload",  "children": [ { "field.int":    { "name": "n" } } ] } },
          { "template.output": { "name": "Alpha", "@payloadRef": "AlphaPayload", "@textRef": "a/x", "@format": "json" } },
          { "template.output": { "name": "Beta",  "@payloadRef": "BetaPayload",  "@textRef": "b/x", "@format": "json" } }
        ]}}
        """;
        var files = new PayloadGenerator().Generate(Ctx(Load(m))).OrderBy(f => f.Path).ToList();
        Assert.Equal(2, files.Count);
        Assert.Equal("AlphaPayload.payload.cs", files[0].Path);
        Assert.Equal("BetaPayload.payload.cs",  files[1].Path);
        Assert.Contains("public sealed record AlphaPayload", files[0].Content);
        Assert.Contains("public sealed record BetaPayload",  files[1].Content);
    }
}
