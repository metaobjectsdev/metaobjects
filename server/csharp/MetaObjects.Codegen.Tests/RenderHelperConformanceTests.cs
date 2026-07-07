using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port conformance for the <c>template.output</c> render-helper generator,
/// loading the SHARED corpus at <c>fixtures/template-output-render-conformance/</c> —
/// the same meta.json + templates/ the TS port loads
/// (<c>render-helper-conformance.test.ts</c>) and the Java port loads
/// (<c>GeneratedRenderHelperConformanceTest</c>), and the oracle pinned in the corpus
/// README. This is the C# half of the cross-port oracle; the expected strings here are
/// IDENTICAL to the TS/Java/Python/Kotlin halves.
///
/// Generate → Roslyn compile → reflectively invoke <c>Render(payload, provider)</c>
/// against the on-disk templates via <see cref="FilesystemProvider"/>, asserting the
/// README outputs byte-for-byte:
///   • document WelcomePage → "Hello Ada"
///   • email WelcomeEmail → subject "Welcome Ada", htmlBody "&lt;p&gt;Hi Ada&lt;/p&gt;", textBody "Hi Ada"
///   • email WelcomeEmail with an XSS-bearing name → html part ESCAPED, text parts RAW
///   • email OrderEmail (nested customer + array items section loop + partial footer)
///   • the drift/ case → the generator THROWS ERR_VAR_NOT_ON_PAYLOAD naming field/ref/template.
/// </summary>
public sealed class RenderHelperConformanceTests
{
    // Walk upward from the test assembly to the repo root (contains the corpus dir).
    private static string Corpus()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !Directory.Exists(Path.Combine(dir, "fixtures", "template-output-render-conformance")))
            dir = Directory.GetParent(dir)?.FullName;
        if (dir is null)
            throw new InvalidOperationException("fixtures/template-output-render-conformance not found");
        return Path.Combine(dir, "fixtures", "template-output-render-conformance");
    }

    private static MetaRoot LoadFromFile(string metaJsonPath)
    {
        var json = File.ReadAllText(metaJsonPath);
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "corpus.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    // Multi-file (multi-package) load — one InMemoryStringSource per file, merged into a
    // single root (mirrors fixtures/conformance/loader-same-name-distinct-packages).
    private static MetaRoot LoadFromFiles(params string[] metaJsonPaths)
    {
        var sources = metaJsonPaths
            .Select((p, i) => (IMetaDataSource)new InMemoryStringSource(File.ReadAllText(p), id: $"corpus{i}.json"))
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

    // ---------------------------------------------------------------------
    // document → "Hello Ada"
    // ---------------------------------------------------------------------

    [Fact]
    public void Document_WelcomePage_matches_corpus_oracle()
    {
        var corpus = Corpus();
        var root = LoadFromFile(Path.Combine(corpus, "meta.json"));
        var templates = Path.Combine(corpus, "templates");

        var file = Assert.Single(new RenderHelperGenerator(templates).Generate(Ctx(root)), f => f.Path == "WelcomePage.render.cs");

        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "Welcome");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var helper = asm.GetType("Acme.Generated.WelcomePageRenderHelper")!;
        var payload = MakeWelcome(asm, "Ada");
        var provider = new FilesystemProvider(templates);
        var outText = (string)helper.GetMethod("Render")!.Invoke(null, [payload, provider])!;
        Assert.Equal("Hello Ada", outText);
    }

    // ---------------------------------------------------------------------
    // email → EmailDocument
    // ---------------------------------------------------------------------

    [Fact]
    public void Email_WelcomeEmail_matches_corpus_oracle()
    {
        var corpus = Corpus();
        var root = LoadFromFile(Path.Combine(corpus, "meta.json"));
        var templates = Path.Combine(corpus, "templates");

        var file = Assert.Single(new RenderHelperGenerator(templates).Generate(Ctx(root)), f => f.Path == "WelcomeEmail.render.cs");

        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "Welcome");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var helper = asm.GetType("Acme.Generated.WelcomeEmailRenderHelper")!;
        var payload = MakeWelcome(asm, "Ada");
        var email = (EmailDocument)helper.GetMethod("Render")!
            .Invoke(null, [payload, new FilesystemProvider(templates)])!;
        Assert.Equal("Welcome Ada", email.Subject);
        Assert.Equal("<p>Hi Ada</p>", email.HtmlBody);
        Assert.Equal("Hi Ada", email.TextBody);
    }

    // ---------------------------------------------------------------------
    // email html SAFETY — @format=html part escapes markup/XSS; @format=text raw.
    // ---------------------------------------------------------------------

    [Fact]
    public void Email_WelcomeEmail_escapes_html_part_but_leaves_text_parts_raw()
    {
        var corpus = Corpus();
        var root = LoadFromFile(Path.Combine(corpus, "meta.json"));
        var templates = Path.Combine(corpus, "templates");

        var file = Assert.Single(new RenderHelperGenerator(templates).Generate(Ctx(root)), f => f.Path == "WelcomeEmail.render.cs");

        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "Welcome");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var helper = asm.GetType("Acme.Generated.WelcomeEmailRenderHelper")!;
        var payload = MakeWelcome(asm, "<b>A & Co</b>");
        var email = (EmailDocument)helper.GetMethod("Render")!
            .Invoke(null, [payload, new FilesystemProvider(templates)])!;

        // html part: < > & entity-escaped → no raw <b> tag reaches a mail client.
        Assert.Equal("<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>", email.HtmlBody);
        Assert.DoesNotContain("<b>A", email.HtmlBody);
        // text parts (@format=text): raw, NOT escaped.
        Assert.Equal("Welcome <b>A & Co</b>", email.Subject);
        Assert.Equal("Hi <b>A & Co</b>", email.TextBody);
    }

    // ---------------------------------------------------------------------
    // email OrderEmail — nested customer + array items {{#items}} loop + partial.
    // nested/meta.json is a NO-PACKAGE sub-corpus; the bare @objectRef resolves by
    // short-name. Shares templates/.
    // ---------------------------------------------------------------------

    [Fact]
    public void Email_OrderEmail_renders_nested_array_loop_and_partial()
    {
        var corpus = Corpus();
        var root = LoadFromFile(Path.Combine(corpus, "nested", "meta.json"));
        var templates = Path.Combine(corpus, "templates");

        // The clean nested template must pass the build-time drift gate (no throw).
        var file = Assert.Single(new RenderHelperGenerator(templates).Generate(Ctx(root)), f => f.Path == "OrderEmail.render.cs");

        // GeneratePayloadRecords(Order) emits Order + nested Customer + Item records;
        // the Order.items property is IReadOnlyList<Item>, so the standalone payload
        // compilation unit needs System.Collections.Generic in scope.
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n"
            + PayloadCodegen.GeneratePayloadRecords(root, "Order");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var customerType = asm.GetType("Acme.Generated.Customer")!;
        var itemType = asm.GetType("Acme.Generated.Item")!;
        var orderType = asm.GetType("Acme.Generated.Order")!;

        var customer = Activator.CreateInstance(customerType)!;
        customerType.GetProperty("name")!.SetValue(customer, "Ada");

        var itemA = Activator.CreateInstance(itemType)!;
        itemType.GetProperty("sku")!.SetValue(itemA, "A1");
        itemType.GetProperty("qty")!.SetValue(itemA, 2);
        var itemB = Activator.CreateInstance(itemType)!;
        itemType.GetProperty("sku")!.SetValue(itemB, "B2");
        itemType.GetProperty("qty")!.SetValue(itemB, 1);

        // items property is IReadOnlyList<Item>; build a typed list via reflection.
        var listType = typeof(List<>).MakeGenericType(itemType);
        var items = (System.Collections.IList)Activator.CreateInstance(listType)!;
        items.Add(itemA);
        items.Add(itemB);

        var order = Activator.CreateInstance(orderType)!;
        orderType.GetProperty("customer")!.SetValue(order, customer);
        orderType.GetProperty("items")!.SetValue(order, items);

        var helper = asm.GetType("Acme.Generated.OrderEmailRenderHelper")!;
        var email = (EmailDocument)helper.GetMethod("Render")!
            .Invoke(null, [order, new FilesystemProvider(templates)])!;

        Assert.Equal("Order for Ada", email.Subject);
        Assert.Equal("<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme", email.HtmlBody);
        Assert.Equal("Order for Ada: A1 x2; B2 x1;", email.TextBody);
        // the partial resolved into the html body.
        Assert.Contains("<hr/>Sent by Acme", email.HtmlBody);
    }

    // ---------------------------------------------------------------------
    // xpkg-collision/ — cross-package short-name collision (ADR-0041). Two packages
    // each declare an object.value `Note` (alpha: alphaText, beta: betaText); the
    // payload `Digest` references BOTH by FULLY-QUALIFIED @objectRef. A bare-tail
    // resolver binds both refs to whichever Note loads first → one of
    // {{fromAlpha.alphaText}}/{{fromBeta.betaText}} lands on the wrong element type and
    // the build-time drift gate throws ERR_VAR_NOT_ON_PAYLOAD. FQN-exact resolution binds
    // each ref to its own package. The two colliding VOs share the BARE record type name
    // `Note`, so (like the TS payloads.ts) the payload record is hand-authored with both
    // fields — the record-name collision is an orthogonal concern; this test gates the
    // render-helper's FQN-exact @objectRef resolver.
    // ---------------------------------------------------------------------

    [Fact]
    public void Document_DigestDoc_resolves_fqn_nested_objectRef_across_collision()
    {
        var corpus = Corpus();
        var dir = Path.Combine(corpus, "xpkg-collision");
        var root = LoadFromFiles(
            Path.Combine(dir, "meta.alpha.json"),
            Path.Combine(dir, "meta.beta.json"),
            Path.Combine(dir, "meta.app.json"));
        var templates = Path.Combine(corpus, "templates");

        // Must NOT throw: the FQN refs resolve to their own package's Note.
        var file = Assert.Single(new RenderHelperGenerator(templates).Generate(Ctx(root)), f => f.Path == "DigestDoc.render.cs");

        var payloadSrc = "namespace Acme.Generated;\n"
            + "public sealed record Note { public string? alphaText { get; init; } public string? betaText { get; init; } }\n"
            + "public sealed record Digest { public Note fromAlpha { get; init; } public Note fromBeta { get; init; } }\n";
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var noteType = asm.GetType("Acme.Generated.Note")!;
        var digestType = asm.GetType("Acme.Generated.Digest")!;
        var fromAlpha = Activator.CreateInstance(noteType)!;
        noteType.GetProperty("alphaText")!.SetValue(fromAlpha, "AA");
        var fromBeta = Activator.CreateInstance(noteType)!;
        noteType.GetProperty("betaText")!.SetValue(fromBeta, "BB");
        var digest = Activator.CreateInstance(digestType)!;
        digestType.GetProperty("fromAlpha")!.SetValue(digest, fromAlpha);
        digestType.GetProperty("fromBeta")!.SetValue(digest, fromBeta);

        var helper = asm.GetType("Acme.Generated.DigestDocRenderHelper")!;
        var outText = (string)helper.GetMethod("Render")!.Invoke(null, [digest, new FilesystemProvider(templates)])!;
        Assert.Equal("Alpha=AA Beta=BB", outText);
    }

    // ---------------------------------------------------------------------
    // drift/ → the generator THROWS ERR_VAR_NOT_ON_PAYLOAD (fails codegen).
    // ---------------------------------------------------------------------

    [Fact]
    public void Drift_case_FAILS_codegen()
    {
        var corpus = Corpus();
        var driftRoot = Path.Combine(corpus, "drift");
        var root = LoadFromFile(Path.Combine(driftRoot, "meta.json"));
        var templates = Path.Combine(driftRoot, "templates");

        var ex = Assert.ThrowsAny<Exception>(() =>
            new RenderHelperGenerator(templates).Generate(Ctx(root)).ToList());
        Assert.Contains("render-helper drift", ex.Message);
        Assert.Contains("WelcomePage", ex.Message);
        Assert.Contains("pages/bad", ex.Message);
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, ex.Message);
        Assert.Contains("missing", ex.Message);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private static object MakeWelcome(Assembly asm, string name)
    {
        var payloadType = asm.GetType("Acme.Generated.Welcome")!;
        var payload = Activator.CreateInstance(payloadType)!;
        payloadType.GetProperty("name")!.SetValue(payload, name);
        return payload;
    }

    private static Assembly CompileToAssembly(params string[] sources)
    {
        var trees = sources.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(Renderer).Assembly.Location));

        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary);
        var comp = CSharpCompilation.Create("rhconf_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
