using MetaObjects;
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Payload-VO + render-handle codegen tests. Mirrors
/// typescript/packages/codegen-ts/test/payload-codegen.test.ts (asserts the
/// emitted C# source; compilation + render of the output is the Phase 3 demo).
/// </summary>
public class PayloadCodegenTests
{
    // PostBrief; AuthorBrief { displayName, postCount, posts: PostBrief[] via collection };
    // contentStrategyPrompt template over AuthorBrief.
    private const string Model = """
    {
      "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": { "name": "PostBrief", "children": [
            { "field.string": { "name": "title" } }
          ]}},
          { "object.projection": { "name": "AuthorBrief", "children": [
            { "field.string": { "name": "displayName" } },
            { "field.int": { "name": "postCount" } },
            { "field.object": { "name": "posts", "isArray": true, "@objectRef": "PostBrief" } }
          ]}},
          { "template.prompt": { "name": "contentStrategyPrompt",
            "@payloadRef": "AuthorBrief", "@textRef": "prompt/strategy", "@format": "xml" } }
        ]
      }
    }
    """;

    private static MetaRoot Load()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "codegen.json")]);
        Assert.Empty(result.Errors);
        return result.Root;
    }

    [Fact]
    public void Emits_payload_record_with_scalar_and_nested_array_fields()
    {
        var src = PayloadCodegen.GeneratePayloadRecords(Load(), "AuthorBrief");
        Assert.Contains("public sealed record AuthorBrief", src);
        Assert.Contains("public string? displayName { get; init; }", src);
        Assert.Contains("public int? postCount { get; init; }", src);
        Assert.Contains("public IReadOnlyList<PostBrief>? posts { get; init; }", src);
        Assert.Contains("public sealed record PostBrief", src);
        Assert.Contains("public string? title { get; init; }", src);
    }

    // Same shape as Model, but the nested @objectRef is authored FULLY-QUALIFIED
    // (acme::ai::PostBrief) — the form a cross-package reference takes. The payload
    // record type + the nested-record lookup must resolve to the BARE short name.
    private const string FqnRefModel = """
    {
      "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": { "name": "PostBrief", "children": [
            { "field.string": { "name": "title" } }
          ]}},
          { "object.projection": { "name": "AuthorBrief", "children": [
            { "field.string": { "name": "displayName" } },
            { "field.object": { "name": "posts", "isArray": true, "@objectRef": "acme::ai::PostBrief" } }
          ]}}
        ]
      }
    }
    """;

    [Fact]
    public void Fully_qualified_objectRef_strips_to_bare_record_type_and_resolves_nested()
    {
        var root = new MetaDataLoader().Load([new InMemoryStringSource(FqnRefModel, id: "fqn.json")]).Root;
        var src = PayloadCodegen.GeneratePayloadRecords(root, "AuthorBrief");
        // Regression: the FQN must NOT leak into the generated C# type or record name.
        Assert.Contains("public IReadOnlyList<PostBrief>? posts { get; init; }", src);
        Assert.Contains("public sealed record PostBrief", src);   // nested record DID resolve (FindObject matched the bare name)
        Assert.DoesNotContain("acme::ai::", src);
    }

    // ADR-0041: cross-package short-name collision. Two object.value `Note`s
    // (acme::alpha with alphaText, acme::beta with betaText) and a payload `Digest`
    // referencing BOTH by FULLY-QUALIFIED @objectRef. The BuildPayloadFieldTree walk (the
    // `dotnet meta verify` field-tree) must bind each ref to its OWN package — not
    // bare-tail-collapse both to whichever Note loads first (pre-fix: both got alphaText).
    // This is the CLI-verify half of the fix; the render-helper half is gated by
    // RenderHelperConformanceTests.Document_DigestDoc_resolves_fqn_nested_objectRef_across_collision.
    [Fact]
    public void BuildPayloadFieldTree_resolves_fqn_nested_objectRef_across_package_collision()
    {
        const string alpha = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "alphaText" } } ] } } ] } }
        """;
        const string beta = """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "betaText" } } ] } } ] } }
        """;
        const string app = """
        { "metadata.root": { "package": "acme::app", "children": [
          { "object.value": { "name": "Digest", "children": [
            { "field.object": { "name": "fromAlpha", "@objectRef": "acme::alpha::Note" } },
            { "field.object": { "name": "fromBeta",  "@objectRef": "acme::beta::Note" } } ] } } ] } }
        """;
        var root = new MetaDataLoader().Load([
            new InMemoryStringSource(alpha, id: "a.json"),
            new InMemoryStringSource(beta,  id: "b.json"),
            new InMemoryStringSource(app,   id: "c.json"),
        ]).Root;

        var tree = PayloadCodegen.BuildPayloadFieldTree(root, "Digest");

        var fromAlpha = Assert.Single(tree, f => f.Name == "fromAlpha");
        var fromBeta = Assert.Single(tree, f => f.Name == "fromBeta");
        // FQN-exact: each ref binds to its OWN package's Note.
        Assert.Equal("alphaText", Assert.Single(fromAlpha.Fields!).Name);
        Assert.Equal("betaText", Assert.Single(fromBeta.Fields!).Name);
    }

    // #228 — the build-time @payloadRef resolver bug class (Python's round-2 fix; the CROSS-PORT
    // checkpoint for this task). Two packages each declare their OWN bare-colliding "Report" and a
    // template.output with a BARE (same-package) @payloadRef "Report" — the realistic common case
    // (a template referencing its own package's local value-object). Before this fix,
    // BuildPayloadFieldTree(root, "Report") had no referrerPkg parameter at all and resolved via a
    // GLOBAL bare-name-first-match scan — VerifyCommand's drift check for EITHER template's
    // "Report" would silently bind to WHICHEVER "Report" happened to load first, regardless of
    // which package the declaring template belonged to. Passing each template's OWN effective
    // package now binds each to ITS OWN "Report" — never the other's, never load-order-dependent.
    [Fact]
    public void BuildPayloadFieldTree_bare_payloadRef_binds_own_package_not_first_loaded()
    {
        const string alpha = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Report", "children": [ { "field.string": { "name": "alphaVal" } } ] } } ] } }
        """;
        const string beta = """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Report", "children": [ { "field.string": { "name": "betaVal" } } ] } } ] } }
        """;
        var root = new MetaDataLoader().Load([
            new InMemoryStringSource(alpha, id: "a.json"),
            new InMemoryStringSource(beta,  id: "b.json"),
        ]).Root;

        // A BARE "Report" ref resolved with alpha's own package binds alpha's Report...
        var alphaTree = PayloadCodegen.BuildPayloadFieldTree(root, "Report", "acme::alpha");
        Assert.Equal("alphaVal", Assert.Single(alphaTree).Name);

        // ...and the SAME bare ref resolved with beta's own package binds beta's Report — never
        // whichever "Report" happened to load first (both alpha-first and beta-first orderings
        // give the SAME per-referrer result, proving this is referrer-scoped, not load-order).
        var betaTree = PayloadCodegen.BuildPayloadFieldTree(root, "Report", "acme::beta");
        Assert.Equal("betaVal", Assert.Single(betaTree).Name);

        // A bare ref with NO referrer package (today's pre-#228 call convention) keeps the
        // permissive global-scan fallback — unaffected callers see unchanged behavior.
        var noReferrerTree = PayloadCodegen.BuildPayloadFieldTree(root, "Report");
        Assert.Single(noReferrerTree);
    }

    [Fact]
    public void Emits_render_handle_binding_textRef_and_format()
    {
        var src = PayloadCodegen.GenerateRenderHandle(Load(), "contentStrategyPrompt");
        Assert.Contains("public static string RenderContentStrategyPrompt(AuthorBrief payload, IProvider provider)", src);
        Assert.Contains("Ref = \"prompt/strategy\"", src);
        Assert.Contains("Format = \"xml\"", src);
        Assert.Contains("using MetaObjects.Render;", src);
    }

    // ADR-0044 no-churn: a non-colliding closure emits BYTE-IDENTICAL output to before the
    // FQN-keyed dedupe + collision-naming fix — bare names, unchanged layout. Full-string
    // (Equal, not Contains) pin so any stray whitespace/ordering churn from the pass 1/2/3
    // refactor fails this.
    [Fact]
    public void No_churn_a_non_colliding_closure_emits_the_exact_pre_fix_bare_name_output()
    {
        var src = PayloadCodegen.GeneratePayloadRecords(Load(), "AuthorBrief", "acme::ai");
        Assert.Equal(
            "public sealed record AuthorBrief\n" +
            "{\n" +
            "    public string? displayName { get; init; }\n" +
            "    public int? postCount { get; init; }\n" +
            "    public IReadOnlyList<PostBrief>? posts { get; init; }\n" +
            "}\n\n" +
            "public sealed record PostBrief\n" +
            "{\n" +
            "    public string? title { get; init; }\n" +
            "}\n",
            src);
    }
}

/// <summary>
/// ADR-0044 (#219/#220) cross-package short-name collision naming: two packages each declare
/// an object.value `Note` with DIFFERENT fields; a third package's `Digest` references both by
/// FULLY-QUALIFIED @objectRef. Pre-ADR-0044 this dedup'd on the BARE name and emitted exactly
/// ONE `record Note` (alpha's shape), typing both fields with it (first-wins). The fix must
/// emit two DISTINCT records.
/// </summary>
public class PayloadCodegenCollisionNamingTests
{
    private static MetaRoot LoadCollidingNotes()
    {
        const string alpha = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "alphaText" } } ] } } ] } }
        """;
        const string beta = """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "betaText" } } ] } } ] } }
        """;
        const string app = """
        { "metadata.root": { "package": "acme::app", "children": [
          { "object.value": { "name": "Digest", "children": [
            { "field.object": { "name": "fromAlpha", "@objectRef": "acme::alpha::Note" } },
            { "field.object": { "name": "fromBeta",  "@objectRef": "acme::beta::Note" } } ] } } ] } }
        """;
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(alpha, id: "a.json"),
            new InMemoryStringSource(beta,  id: "b.json"),
            new InMemoryStringSource(app,   id: "c.json"),
        ]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    [Fact]
    public void Emits_two_distinct_package_qualified_records_not_one_merged_first_wins_shape()
    {
        var root = LoadCollidingNotes();
        var src = PayloadCodegen.GeneratePayloadRecords(root, "acme::app::Digest");
        // Exact byte pin (not just Contains): proves ordering, field sets, and both scalars
        // survive untouched — Digest first (closure root), then each collision member under
        // its PascalCase package-qualified name.
        Assert.Equal(
            "public sealed record Digest\n" +
            "{\n" +
            "    public AcmeAlphaNote? fromAlpha { get; init; }\n" +
            "    public AcmeBetaNote? fromBeta { get; init; }\n" +
            "}\n\n" +
            "public sealed record AcmeAlphaNote\n" +
            "{\n" +
            "    public string? alphaText { get; init; }\n" +
            "}\n\n" +
            "public sealed record AcmeBetaNote\n" +
            "{\n" +
            "    public string? betaText { get; init; }\n" +
            "}\n",
            src);
        Assert.DoesNotContain("record Note", src);
    }

    [Fact]
    public void GenerateRenderHandle_types_the_payload_param_under_the_same_collision_aware_name()
    {
        const string appWithTemplate = """
        { "metadata.root": { "package": "acme::app", "children": [
          { "object.value": { "name": "Digest", "children": [
            { "field.object": { "name": "fromAlpha", "@objectRef": "acme::alpha::Note" } },
            { "field.object": { "name": "fromBeta",  "@objectRef": "acme::beta::Note" } } ] } },
          { "template.output": { "name": "DigestDoc",
            "@payloadRef": "acme::app::Digest", "@textRef": "xpkg/digest", "@format": "html" } }
        ]}}
        """;
        const string alpha = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "alphaText" } } ] } } ] } }
        """;
        const string beta = """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "betaText" } } ] } } ] } }
        """;
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(alpha, id: "a.json"),
            new InMemoryStringSource(beta,  id: "b.json"),
            new InMemoryStringSource(appWithTemplate, id: "c.json"),
        ]);
        Assert.Empty(r.Errors);

        // Digest's OWN closure collides on Note, but Digest itself is unique, so its
        // render-handle payload param stays bare "Digest" while the nested Notes qualify.
        var handle = PayloadCodegen.GenerateRenderHandle(r.Root, "DigestDoc");
        Assert.Contains("public static string RenderDigestDoc(Digest payload, IProvider provider) =>", handle);
    }

    // Pathological backstop: "acme::alpha::Note" and "acmeAlpha::Note" both PascalCase-fold to
    // the SAME derived name "AcmeAlphaNote" — qualification cannot disambiguate. Must fail loud.
    [Fact]
    public void Still_colliding_derived_name_fails_loud_with_ERR_PAYLOAD_NAME_COLLISION()
    {
        const string alpha = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "a" } } ] } } ] } }
        """;
        const string acmeAlpha = """
        { "metadata.root": { "package": "acmeAlpha", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "b" } } ] } } ] } }
        """;
        const string app = """
        { "metadata.root": { "package": "acme::app", "children": [
          { "object.value": { "name": "Digest", "children": [
            { "field.object": { "name": "x", "@objectRef": "acme::alpha::Note" } },
            { "field.object": { "name": "y", "@objectRef": "acmeAlpha::Note" } } ] } } ] } }
        """;
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(alpha, id: "a.json"),
            new InMemoryStringSource(acmeAlpha, id: "b.json"),
            new InMemoryStringSource(app, id: "c.json"),
        ]);
        Assert.Empty(r.Errors);

        var ex = Assert.Throws<InvalidOperationException>(
            () => PayloadCodegen.GeneratePayloadRecords(r.Root, "acme::app::Digest"));
        Assert.Contains("ERR_PAYLOAD_NAME_COLLISION", ex.Message);
        Assert.Contains("\"AcmeAlphaNote\"", ex.Message);
        Assert.Contains("\"acme::alpha::Note\"", ex.Message);
        Assert.Contains("\"acmeAlpha::Note\"", ex.Message);
    }
}
