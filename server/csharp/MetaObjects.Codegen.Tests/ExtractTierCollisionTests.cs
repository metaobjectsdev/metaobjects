// #228 — extract / output-parser tier collision-scoped naming (C# port).
//
// Loads the SHARED cross-port corpus at
// fixtures/template-output-render-conformance/xpkg-collision-json/ — a Digest payload with
// two field.object children, each FQN-@objectRef-ing a DIFFERENT package's same-bare-named
// Note (acme::alpha::Note / acme::beta::Note). The SAME corpus the TS
// (extract-tier-collision.test.ts) and Python (test_extract_tier_collision.py) #228 tasks load.
//
// Design invariant (cross-port ruling): each port's extractor STRICT type = that port's
// CANONICAL strict artifact = the payload record. For C# that is the PayloadCodegen record
// (AcmeAlphaNote / AcmeBetaNote under ADR-0044 collision-scoped naming) — reused (never
// re-derived) by ExtractDelegateEmitter/ExtractorGenerator/OutputParserGenerator via the
// shared PayloadCodegen closure name-map (PayloadCodegen.ComputeClosureAndNames /
// PayloadCodegen.EmittedNameOf).
//
// Before the fix: ExtractDelegateEmitter.FindObject/RefVo matched by bare Name only (falling
// back to a bare-tail short-name match for an FQN ref — the #219/#244 "wrong node" pattern),
// MirrorName/MapperName were bare-Name-keyed (so a cross-package short-name collision either
// bound the WRONG package's Note or silently DROPPED the second one via bare-Name-keyed `seen`
// sets), and OutputParserGenerator/ExtractorGenerator resolved their OWN top-level @payloadRef
// via a bare/global-scan (no referrer-package awareness) rather than PayloadCodegen's own
// collision-aware emitted name.
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ExtractTierCollisionTests
{
    private static string Corpus()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !Directory.Exists(Path.Combine(dir, "fixtures", "template-output-render-conformance", "xpkg-collision-json")))
            dir = Directory.GetParent(dir)?.FullName;
        if (dir is null)
            throw new InvalidOperationException("fixtures/template-output-render-conformance/xpkg-collision-json not found");
        return Path.Combine(dir, "fixtures", "template-output-render-conformance", "xpkg-collision-json");
    }

    private static MetaRoot LoadCorpus()
    {
        var dir = Corpus();
        var sources = new[] { "meta.alpha.json", "meta.beta.json", "meta.app.json" }
            .Select((f, i) => (IMetaDataSource)new InMemoryStringSource(File.ReadAllText(Path.Combine(dir, f)), id: $"corpus{i}.json"))
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
    public void Output_parser_and_extractor_emit_both_qualified_collision_members_never_bare_note()
    {
        var root = LoadCorpus();
        var ctx = Ctx(root);

        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(ctx), f => f.Path == "DigestDoc.output.cs").Content;
        var extractorFile = Assert.Single(new ExtractorGenerator().Generate(ctx));
        var extractorSrc = extractorFile.Content;

        // The extractor class + file are named off the ROOT payload's emitted name (Digest
        // itself doesn't collide, so it stays bare) — never off the colliding NESTED Note.
        Assert.Equal("DigestExtractor.cs", extractorFile.Path);
        Assert.Contains("public static class DigestExtractor", extractorSrc);

        // ---- output-parser: BOTH mirror records + mappers present, collision-scoped ----
        // (never bare/dropped — the #219-class dedupe-by-name defect this fix closes).
        Assert.Contains("public sealed record AcmeAlphaNoteExtracted", parserSrc);
        Assert.Contains("public sealed record AcmeBetaNoteExtracted", parserSrc);
        Assert.DoesNotContain("public sealed record NoteExtracted", parserSrc);
        Assert.Contains("FromAcmeAlphaNoteExtracted(", parserSrc);
        Assert.Contains("FromAcmeBetaNoteExtracted(", parserSrc);
        Assert.DoesNotContain("FromNoteExtracted(", parserSrc);

        // The root Digest mirror's fields reference the qualified nested mirror types.
        Assert.Contains("AcmeAlphaNoteExtracted? fromAlpha { get; init; }", parserSrc);
        Assert.Contains("AcmeBetaNoteExtracted? fromBeta { get; init; }", parserSrc);

        // ---- extractor: mappers for BOTH qualified STRICT payload types (PayloadCodegen's
        //      own record names — the reused, never-re-derived, canonical strict artifact) ----
        Assert.Contains("ToStrict_AcmeAlphaNote(", extractorSrc);
        Assert.Contains("ToStrict_AcmeBetaNote(", extractorSrc);
        Assert.DoesNotContain("ToStrict_Note(", extractorSrc);

        // No bare "Note" identifier/type token anywhere in either generated file (word-boundary
        // — "AcmeAlphaNote"/"AcmeBetaNote" do NOT match \bNote\b since "a"/"N" share no boundary).
        Assert.DoesNotMatch(@"\bNote\b", parserSrc);
        Assert.DoesNotMatch(@"\bNote\b", extractorSrc);
    }

    // Compile + RUN — the strongest proof: each nested VO extracts into ITS OWN shape, never the
    // other's (the #219/#244 "wrong node" bug), and neither is dropped.
    [Fact]
    public void Generated_extractor_compiles_and_extracts_each_nested_vo_into_its_own_shape()
    {
        var root = LoadCorpus();
        var ctx = Ctx(root);

        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(ctx), f => f.Path == "DigestDoc.output.cs").Content;
        var extractorSrc = Assert.Single(new ExtractorGenerator().Generate(ctx)).Content;
        // GENERATOR-emitted payload records (PayloadCodegen — never hand-authored), resolved via
        // the FQN root VO (mirrors RenderHelperConformanceTests' xpkg-collision precedent).
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n"
            + PayloadCodegen.GeneratePayloadRecords(root, "acme::app::Digest");

        var asm = Compile(parserSrc, extractorSrc, payloadSrc);

        var extractorType = asm.GetType("Acme.Generated.DigestExtractor")!;
        var extract = extractorType.GetMethod("Extract", new[] { typeof(MetaObject), typeof(string) })!;

        MetaObject digestMo = root.FindObject("Digest")!;

        const string text = "{ \"fromAlpha\": { \"alphaText\": \"AA\" }, \"fromBeta\": { \"betaText\": \"BB\" } }";

        var digest = extract.Invoke(null, new object?[] { digestMo, text })!;

        var fromAlpha = digest.GetType().GetProperty("fromAlpha")!.GetValue(digest)!;
        Assert.Equal("AcmeAlphaNote", fromAlpha.GetType().Name);
        Assert.Equal("AA", fromAlpha.GetType().GetProperty("alphaText")!.GetValue(fromAlpha));
        // Proves no wrong-node cross-wire: alpha's record has NO betaText property at all.
        Assert.Null(fromAlpha.GetType().GetProperty("betaText"));

        var fromBeta = digest.GetType().GetProperty("fromBeta")!.GetValue(digest)!;
        Assert.Equal("AcmeBetaNote", fromBeta.GetType().Name);
        Assert.Equal("BB", fromBeta.GetType().GetProperty("betaText")!.GetValue(fromBeta));
        Assert.Null(fromBeta.GetType().GetProperty("alphaText"));
    }

    // ---------------------------------------------------------------------
    // no-churn — a non-colliding template.output payload keeps bare names (qualification
    // never fires). Global constraint: byte-identical when there is no collision.
    // ---------------------------------------------------------------------

    [Fact]
    public void No_churn_non_colliding_payload_keeps_bare_names()
    {
        const string m = """
        { "metadata.root": { "package": "acme::demo", "children": [
          { "object.value": { "name": "Detail", "children": [
            { "field.string": { "name": "note", "@required": true } }
          ]}},
          { "object.value": { "name": "Widget", "children": [
            { "field.object": { "name": "detail", "@objectRef": "Detail", "@required": true } }
          ]}},
          { "template.output": { "name": "WidgetOut", "@payloadRef": "Widget",
              "@textRef": "x/y", "@format": "json" } }
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(m, id: "widget.json")]);
        Assert.Empty(r.Errors);
        var ctx = Ctx(r.Root);

        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(ctx)).Content;
        var extractorFile = Assert.Single(new ExtractorGenerator().Generate(ctx));

        Assert.Equal("WidgetExtractor.cs", extractorFile.Path);
        Assert.Contains("public static Widget Parse(string text)", parserSrc);
        Assert.Contains("public static class WidgetExtractor", extractorFile.Content);
        Assert.DoesNotContain("AcmeDemo", parserSrc);
        Assert.DoesNotContain("AcmeDemo", extractorFile.Content);
    }

    // ---------------------------------------------------------------------
    // #228 fix round 1 — the RUNTIME PAYLOAD_FQN lookup wrong-node bug. Payload
    // records/extractors/output-parsers ALWAYS emit into ONE FLAT namespace
    // (ctx.Config.Namespace), while entities (and owned value-objects referenced by an
    // entity) can emit into PER-PACKAGE namespaces via PackageBindingResolver (FR-019 —
    // the recommended setup for multi-package projects). So an object.value "Report"
    // (this @payloadRef, in acme::beta) and an UNRELATED object.entity "Report" (in
    // acme::alpha) can BOTH load (ADR-0042 makes cross-package bare short names legal)
    // AND compile cleanly (different namespaces — no duplicate-type error) while
    // sharing the exact same bare short name. Before this fix, the generated
    // ExtractLenient(MetaRoot, string) overload resolved its payload via a bare
    // root.FindObject("Report") (MetaRoot's public runtime API — package-blind,
    // first-match) — reachable, COMPILING, and silently wrong-node at runtime (the
    // build-time resolver fix earlier in this file does NOT cover this: it only
    // decides which node the GENERATOR walks, not what the GENERATED CODE looks up
    // at runtime).
    // ---------------------------------------------------------------------

    [Fact]
    public void ExtractLenient_MetaRoot_overload_binds_the_payload_not_a_same_named_entity_in_another_package()
    {
        const string alphaEntity = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.entity": { "name": "Report", "children": [
            { "source.rdb": { "@table": "reports" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        const string betaPayload = """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Report", "children": [
            { "field.string": { "name": "betaVal", "@required": true } }
          ]}},
          { "template.output": { "name": "ReportDoc", "@payloadRef": "Report",
              "@textRef": "x/y", "@format": "json" } }
        ]}}
        """;
        // Adversarial load order: alpha's ENTITY "Report" loads FIRST, so a package-blind
        // bare-name-first-match runtime lookup would bind IT, never beta's payload value.
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(alphaEntity, id: "alpha.json"),
            new InMemoryStringSource(betaPayload, id: "beta.json"),
        ]);
        Assert.Empty(r.Errors);
        var root = r.Root;

        var config = new GenConfig
        {
            OutDir = "/tmp",
            Namespace = "Acme.Generated",
            // FR-019 per-package namespace binding — acme::alpha's entities land in a
            // DIFFERENT namespace than the flat payload/output-parser namespace, so the
            // two same-bare-named "Report"s do NOT collide at compile time (proving the
            // scenario is reachable in a real, recommended multi-package setup).
            PackageNamespaces = new Dictionary<string, string> { ["acme::alpha"] = "Acme.Alpha" },
        };
        var ctx = new GenContext { Entities = root.Objects(), Root = root, Config = config };

        var entitySrc = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(ctx), f => f.Path == "ReportDoc.output.cs").Content;
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n"
            + PayloadCodegen.GeneratePayloadRecords(root, "acme::beta::Report");

        // The entity lands in its OWN per-package namespace, distinct from the flat
        // payload namespace — proves the "no compile collision" premise this bug relies on.
        Assert.Contains("namespace Acme.Alpha;", entitySrc);
        Assert.Contains("public class Report", entitySrc);
        Assert.Contains("namespace Acme.Generated;", parserSrc);

        // The runtime PAYLOAD_FQN lookup bakes the FULL FQN (never the bare, ambiguous
        // "Report") and resolves via the canonical FQN-exact matcher — never MetaRoot's
        // bare-name-first-match FindObject.
        Assert.Contains("public const string PAYLOAD_FQN = \"acme::beta::Report\";", parserSrc);
        Assert.Contains("global::MetaObjects.NamingRefs.ResolveObjectRef(root, PAYLOAD_FQN, \"\")", parserSrc);
        Assert.DoesNotContain("root.FindObject(PAYLOAD_FQN)", parserSrc);

        var asm = Compile(entitySrc, parserSrc, payloadSrc);

        var parserType = asm.GetType("Acme.Generated.ReportDocParser")!;
        var extractLenientWithLoader = parserType.GetMethods()
            .Single(m => m.Name == "ExtractLenient" && m.GetParameters()[0].ParameterType == typeof(MetaRoot));

        const string text = "{ \"betaVal\": \"BV\" }";
        var result = extractLenientWithLoader.Invoke(null, new object?[] { root, text, null })!;
        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;

        // Binds the PAYLOAD value's shape (betaVal), NOT the entity's (id) — the wrong-node
        // bug would have assembled the graph against alpha's entity schema instead, losing
        // betaVal entirely (no such property on the entity's field set).
        Assert.Equal("BV", data.GetType().GetProperty("betaVal")!.GetValue(data));
    }

    private static Assembly Compile(params string[] sources)
    {
        var trees = sources.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));

        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            .WithSpecificDiagnosticOptions(new Dictionary<string, ReportDiagnostic>
            {
                ["CS8619"] = ReportDiagnostic.Error, // nullable-covariance mismatch must fail the proof
            });
        var comp = CSharpCompilation.Create("extract_collision_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
