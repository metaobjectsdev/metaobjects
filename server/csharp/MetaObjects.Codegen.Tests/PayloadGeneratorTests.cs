using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// PayloadGenerator emission tests (the <c>&lt;Name&gt;.payload.cs</c> wrapper around
/// <see cref="PayloadCodegen.GeneratePayloadRecords"/>). TWO walks feed it: the OUTBOUND
/// <c>template.output @payloadRef</c> and, per ADR-0052, the INBOUND
/// <c>template.prompt @responseRef</c>. Covers the ADR-0044
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
    public void Emits_no_files_when_there_are_no_templates()
    {
        // The record follows @payloadRef, not the subtype, so "no files" no longer means "no
        // template.output" — a template.prompt gets one too (Emits_the_request_record_for_a_prompt).
        // With @payloadRef both REQUIRED and loader-validated to an object.value / sourceless
        // object.projection, a declared template that resolves to nothing is unreachable in a
        // valid load; a root with no templates is the honest empty case. The generator's
        // defensive skip for an unresolvable ref is covered where it IS reachable —
        // OutputParserGeneratorTests.A_responseRef_that_is_not_a_value_object_emits_no_parser,
        // which exists precisely because @responseRef has no such loader rule.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "x" } } ] } }
        ]}}
        """;
        var files = new PayloadGenerator().Generate(Ctx(Load(m))).ToList();
        Assert.Empty(files);
    }

    [Fact]
    public void Emits_the_request_record_for_a_prompt()
    {
        // C# filtered this walk to template.output, so a prompt's REQUEST shape — the payload a
        // consumer constructs by hand and passes to the render API — got no record in this port
        // while Java, Kotlin and Python all emitted one. It looks unbound from inside codegen
        // because the render HELPER is outbound-only in every port, but the shipped adopter docs
        // show exactly that call for a prompt (docs/features/templates-and-payloads.md:224).
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.prompt": { "name": "promptOnly", "@payloadRef": "Payload", "@textRef": "p/x", "@format": "text" } }
        ]}}
        """;
        var file = Assert.Single(new PayloadGenerator().Generate(Ctx(Load(m))));
        Assert.Equal("Payload.payload.cs", file.Path);
        Assert.Contains("public sealed record Payload", file.Content);
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
        // field.decimal is precision-exact — `decimal`, never `double` (#309). This
        // assertion pinned `double` while the entity generator, ADR-0019, Kotlin/Java
        // (BigDecimal) and TypeScript (string) all said otherwise.
        Assert.Contains("public decimal? confidence { get; init; }", file.Content);
        Assert.Contains("public NoteEntry? note { get; init; }", file.Content);
        Assert.Contains("public sealed record NoteEntry", file.Content);
        Assert.Contains("public string? value { get; init; }", file.Content);
        // The FQN must not leak into the file name or the record/type names.
        Assert.DoesNotContain("acme::intake::", file.Content);
        Assert.DoesNotContain("::", file.Path);
    }

    // ── ADR-0052, the INBOUND half ──────────────────────────────────────────────────
    // These are the gate for the headline change. Before them, deleting the @responseRef
    // walk out of PayloadGenerator.Generate left the whole C# suite GREEN: every other
    // test's fixture set @responseRef == @payloadRef, so the outbound walk emitted the
    // same record by coincidence and nothing could tell the two apart.

    [Fact]
    public void Emits_the_response_record_for_a_responding_prompt()
    {
        // A responding prompt's @responseRef names the shape its generated parser RETURNS,
        // and that shape needs a strict record of its own. It is NOT the prompt's
        // @payloadRef, which types the request rendered outbound — here they are
        // deliberately DIFFERENT value-objects, which is the only way this can discriminate.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "SupportRequest", "children": [
            { "field.string": { "name": "question" } }
          ]}},
          { "object.value": { "name": "SupportAnswer", "children": [
            { "field.string":  { "name": "answer" } },
            { "field.decimal": { "name": "confidence" } }
          ]}},
          { "template.prompt": { "name": "SupportPrompt", "@payloadRef": "SupportRequest",
                                 "@responseRef": "SupportAnswer", "@textRef": "support/ask",
                                 "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var files = new PayloadGenerator().Generate(Ctx(Load(m))).OrderBy(f => f.Path).ToList();

        // BOTH shapes get a record, in different files: the request this prompt renders outbound
        // and the reply its parser returns are different declared shapes. This test previously
        // asserted the request record was ABSENT, on the reasoning that nothing generated binds
        // it — true of generated code, false of the shipped consumer surface.
        Assert.Equal(2, files.Count);
        var answer = Assert.Single(files, f => f.Path == "SupportAnswer.payload.cs");
        var request = Assert.Single(files, f => f.Path == "SupportRequest.payload.cs");

        // Each is named after its resolved VALUE-OBJECT — not the template.
        Assert.Contains("public sealed record SupportAnswer", answer.Content);
        Assert.Contains("public string? answer { get; init; }", answer.Content);
        Assert.Contains("public decimal? confidence { get; init; }", answer.Content);
        Assert.Contains("public sealed record SupportRequest", request.Content);
        Assert.Contains("public string? question { get; init; }", request.Content);
    }

    [Fact]
    public void One_record_when_an_output_payload_and_a_prompt_response_name_the_same_shape()
    {
        // The record is named after the resolved VALUE-OBJECT, so the outbound and inbound
        // walks can legitimately land on the same path — an output's @payloadRef and a
        // prompt's @responseRef may be the same declared shape. CodegenRunner THROWS on a
        // duplicate emitted path (no byte-identical collapse like TS #266), so the dedupe
        // by resolved VO FQN is load-bearing, not cosmetic.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Ticket", "children": [ { "field.string": { "name": "summary" } } ] } },
          { "template.output": { "name": "TicketDoc", "@payloadRef": "Ticket",
                                 "@textRef": "t/doc", "@format": "text" } },
          { "template.prompt": { "name": "TicketPrompt", "@payloadRef": "Ticket",
                                 "@responseRef": "Ticket", "@textRef": "t/ask",
                                 "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var file = Assert.Single(new PayloadGenerator().Generate(Ctx(Load(m))));
        Assert.Equal("Ticket.payload.cs", file.Path);
        Assert.Contains("public sealed record Ticket", file.Content);
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
            { "field.string": { "name": "internalNotes" } },
            { "field.object": { "name": "thumb", "@objectRef": "FullThumb" } }
          ]}},
          { "object.value": { "name": "Highlight", "children": [
            { "field.string": { "name": "snippet" } }
          ]}},
          { "object.value": { "name": "FullThumb", "children": [
            { "field.string": { "name": "internalUrl" } }
          ]}},
          { "object.projection": { "name": "Digest", "children": [
            { "field.string": { "name": "displayName", "extends": "Source.displayName" } },
            { "field.int": { "name": "alias", "children": [
              { "origin.passthrough": { "@from": "Source.displayName", "@convert": true } }
            ]}},
            { "field.string": { "name": "summary", "children": [
              { "origin.aggregate": { "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } }
            ]}},
            { "field.object": { "name": "posts", "@objectRef": "Highlight", "isArray": true, "children": [
              { "origin.aggregate": { "@agg": "collect", "@of": "Post.thumb", "@via": "Author.posts" } }
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
        // Declared `field.string` wins over the numeric count — no origin-derived type.
        Assert.Contains("public string? summary { get; init; }", file.Content);
        // Declared `field.object @objectRef` + isArray wins over the disagreeing @of walk.
        Assert.Contains("public IReadOnlyList<Highlight>? posts { get; init; }", file.Content);
        Assert.Contains("public sealed record Highlight", file.Content);
        Assert.Contains("public string? snippet { get; init; }", file.Content);
        // The ignored origin targets never enter the closure. FullThumb is the sharp one:
        // it is an object.value reached through `@of`, i.e. exactly the node KIND the
        // closure does walk — so this rules out an origin edge, not merely a type mismatch.
        // (Before FR-037 R2 this arm used `origin.collection @via`, whose target was an
        // ENTITY the closure would never walk regardless; the retirement made it stronger.)
        Assert.DoesNotContain("record FullThumb", file.Content);
        Assert.DoesNotContain("internalUrl", file.Content);
        Assert.DoesNotContain("record Post", file.Content);
        Assert.DoesNotContain("internalNotes", file.Content);
    }
}
