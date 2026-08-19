using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// PayloadGenerator emission tests (the <c>template.output</c> -&gt; <c>&lt;Name&gt;.payload.cs</c>
/// wrapper around <see cref="PayloadCodegen.GeneratePayloadRecords"/>). Covers the ADR-0044
/// (#219) fix end-to-end at the GENERATOR layer:
///   - a template.output declared in a NAMED package with a BARE @payloadRef must resolve
///     (the generator now threads the template's own package into GeneratePayloadRecords —
///     see EmitPayload/NamingRefs.EffectivePackage);
///   - the emitted FILE NAME comes from the resolved root VO's ADR-0044 EMITTED name, never
///     a raw (possibly FQN) payloadRef.
/// </summary>
public sealed class PayloadGeneratorTests
{
    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "payload-gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static MetaRoot LoadMulti(params string[] models)
    {
        var sources = models
            .Select((m, i) => (IMetaDataSource)new InMemoryStringSource(m, id: $"payload-gen-{i}.json"))
            .ToArray();
        var r = new MetaDataLoader().Load(sources);
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

    // Regression (the fix formerly proposed on the unmerged fix/csharp-payload-generator-bare-payloadref
    // branch — subsumed by ADR-0044): a template.output in a NAMED package (not the default/root
    // package) with a BARE @payloadRef. Before the ADR-0044 fix, EmitPayload never threaded the
    // template's own package into GeneratePayloadRecords, so a bare top-level payloadRef in a named
    // package resolved only by luck (the old FindObject's unscoped global bare-name scan).
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
        Assert.Contains("public string? documentType { get; init; }", file.Content);
        Assert.Contains("public double? confidence { get; init; }", file.Content);
        Assert.Contains("public NoteEntry? note { get; init; }", file.Content);
        Assert.Contains("public sealed record NoteEntry", file.Content);
        Assert.Contains("public string? value { get; init; }", file.Content);
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

    // ADR-0044 (#219/#220) — the collision domain for a C# one-file-per-payload emitter is
    // the emitted FILE (<Payload>.payload.cs): a SINGLE template.output's payload closure
    // containing two same-short-name VOs (mirrors fixtures/template-output-render-conformance/
    // xpkg-collision/ end-to-end through the REAL generator, not just PayloadCodegen directly).
    // The file name stays "Digest.payload.cs" (Digest itself doesn't collide); the two nested
    // Notes disambiguate via their package-qualified derived names.
    [Fact]
    public void Collision_within_one_payloadRefs_closure_emits_two_distinct_qualified_records()
    {
        var root = LoadMulti(
            """
            { "metadata.root": { "package": "acme::alpha", "children": [
              { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "alphaText" } } ] } }
            ]}}
            """,
            """
            { "metadata.root": { "package": "acme::beta", "children": [
              { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "betaText" } } ] } }
            ]}}
            """,
            """
            { "metadata.root": { "package": "acme::app", "children": [
              { "object.value": { "name": "Digest", "children": [
                { "field.object": { "name": "fromAlpha", "@objectRef": "acme::alpha::Note" } },
                { "field.object": { "name": "fromBeta",  "@objectRef": "acme::beta::Note" } }
              ]}},
              { "template.output": { "name": "DigestDoc", "@payloadRef": "Digest", "@textRef": "x/y", "@format": "text" } }
            ]}}
            """);

        var files = new PayloadGenerator().Generate(Ctx(root)).ToList();
        var file = Assert.Single(files);
        // The root (Digest) doesn't collide — the file name stays bare, matching the ADR-0044
        // no-churn claim (unaffected by the collision one level down in its own closure).
        Assert.Equal("Digest.payload.cs", file.Path);
        Assert.Contains("public sealed record Digest", file.Content);
        Assert.Contains("public sealed record AcmeAlphaNote", file.Content);
        Assert.Contains("public string? alphaText { get; init; }", file.Content);
        Assert.Contains("public sealed record AcmeBetaNote", file.Content);
        Assert.Contains("public string? betaText { get; init; }", file.Content);
        Assert.Contains("public AcmeAlphaNote? fromAlpha { get; init; }", file.Content);
        Assert.Contains("public AcmeBetaNote? fromBeta { get; init; }", file.Content);
        Assert.DoesNotContain("public sealed record Note", file.Content);
    }

    // #270 reference-emitter pin — C# is one of the two genuinely origin-blind REFERENCE
    // payload emitters the Kotlin / Python / Java ports converged on, but nothing gated
    // that: this pins that an `origin.*` child on a payload-shape field is IGNORED for
    // typing — the declared `field.<subType>` + `isArray` + `@objectRef` win — so a
    // future change cannot drift this reference into origin dispatch (the drift that
    // let three ports diverge in the first place). Test-only: product code untouched.
    [Fact]
    public void Origin_children_are_ignored_for_typing_declared_type_wins()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.entity": { "name": "Source", "children": [
            { "field.string": { "name": "displayName" } }
          ]}},
          { "object.entity": { "name": "Author", "children": [
            { "field.long": { "name": "id" } },
            { "relationship.aggregation": { "name": "posts", "@objectRef": "Post", "@cardinality": "many" } }
          ]}},
          { "object.entity": { "name": "Post", "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "internalNotes" } }
          ]}},
          { "object.value": { "name": "Highlight", "children": [
            { "field.string": { "name": "snippet" } }
          ]}},
          { "object.projection": { "name": "Digest", "children": [
            { "field.string": { "name": "displayName", "extends": "Source.displayName" } },
            { "field.int": { "name": "alias", "children": [
              { "origin.passthrough": { "@from": "Source.displayName", "@convert": true } }
            ]}},
            { "field.string": { "name": "summary", "children": [
              { "origin.collection": { "@via": "Author.posts" } }
            ]}},
            { "field.object": { "name": "posts", "@objectRef": "Highlight", "isArray": true, "children": [
              { "origin.collection": { "@via": "Author.posts" } }
            ]}}
          ]}},
          { "template.output": { "name": "DigestDoc",
            "@payloadRef": "Digest", "@textRef": "ai/digest", "@format": "json" } }
        ]}}
        """;
        var files = new PayloadGenerator().Generate(Ctx(Load(m))).ToList();
        var file = Assert.Single(files);
        Assert.Equal("Digest.payload.cs", file.Path);
        // Declared `field.int` wins over the (`@convert`-acknowledged) string passthrough.
        Assert.Contains("public int? alias { get; init; }", file.Content);
        Assert.DoesNotContain("string alias", file.Content);
        // Declared `field.string` wins over origin.collection — no list, no via-target type.
        Assert.Contains("public string? summary { get; init; }", file.Content);
        // Declared `field.object @objectRef` + isArray wins over the disagreeing @via walk.
        Assert.Contains("public IReadOnlyList<Highlight>? posts { get; init; }", file.Content);
        Assert.Contains("public sealed record Highlight", file.Content);
        Assert.Contains("public string? snippet { get; init; }", file.Content);
        // The ignored @via entity never enters the closure.
        Assert.DoesNotContain("record Post", file.Content);
        Assert.DoesNotContain("internalNotes", file.Content);
    }
}
