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
/// RenderHelperGenerator emission + behavior tests (render-helper phase 2, Task 4).
/// Mirrors the shipped TS (render-helper-file.ts / templates/render-helper.ts) and
/// Java (SpringRenderHelperGenerator) ports: per-template.output typed render helper
/// wrapping the EXISTING <see cref="Renderer"/> engine, with the mustache↔payload-VO
/// drift check (<see cref="Verify"/>) enforced at BUILD time.
///
/// The headline is the build-time drift gate: codegen FAILS (the generator throws)
/// when a referenced mustache's `{{field}}` is not on the payload VO.
/// </summary>
public sealed class RenderHelperCodegenTests
{
    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "outputs.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // Write a set of group/source.mustache files under a fresh temp template root.
    private static string TemplateRoot(params (string Ref, string Body)[] mustaches)
    {
        var root = Path.Combine(Path.GetTempPath(), "rh_" + Guid.NewGuid().ToString("N"));
        foreach (var (refr, body) in mustaches)
        {
            var file = Path.Combine([root, .. refr.Split('/')]) + ".mustache";
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, body);
        }
        return root;
    }

    // ---------------------------------------------------------------------
    // Document kind — emit shape + Roslyn compile-run
    // ---------------------------------------------------------------------

    [Fact]
    public void Document_emits_render_helper_returning_string_and_renders()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Welcome", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "WelcomePage", "@kind": "document", "@format": "html",
                                  "@textRef": "pages/welcome", "@payloadRef": "Welcome" } }
        ]}}
        """;
        var root = Load(m);
        var templateRoot = TemplateRoot(("pages/welcome", "Hello {{name}}"));

        var file = Assert.Single(new RenderHelperGenerator(templateRoot).Generate(Ctx(root)));
        Assert.Equal("WelcomePage.render.cs", file.Path);
        Assert.Contains("public static class WelcomePageRenderHelper", file.Content);
        Assert.Contains("public static string Render(Welcome payload, global::MetaObjects.Render.IProvider provider)", file.Content);

        // Compile the helper alongside the payload record, then reflectively render.
        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "Welcome");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var helper = asm.GetType("Acme.Generated.WelcomePageRenderHelper")!;
        var payloadType = asm.GetType("Acme.Generated.Welcome")!;
        var payload = Activator.CreateInstance(payloadType)!;
        payloadType.GetProperty("name")!.SetValue(payload, "Ada");

        var provider = new FilesystemProvider(templateRoot);
        var render = helper.GetMethod("Render")!;
        var outText = (string)render.Invoke(null, new object[] { payload, provider })!;
        Assert.Equal("Hello Ada", outText);
    }

    // ---------------------------------------------------------------------
    // Email kind — emit shape + Roslyn compile-run → EmailDocument
    // ---------------------------------------------------------------------

    [Fact]
    public void Email_emits_render_helper_returning_EmailDocument_and_renders()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Welcome", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "WelcomeEmail", "@kind": "email",
                                  "@subjectRef": "email/subject", "@htmlBodyRef": "email/html",
                                  "@textBodyRef": "email/text", "@payloadRef": "Welcome" } }
        ]}}
        """;
        var root = Load(m);
        var templateRoot = TemplateRoot(
            ("email/subject", "Hi {{name}}"),
            ("email/html", "<p>Hello {{name}}</p>"),
            ("email/text", "Hello {{name}}"));

        var file = Assert.Single(new RenderHelperGenerator(templateRoot).Generate(Ctx(root)));
        Assert.Equal("WelcomeEmail.render.cs", file.Path);
        Assert.Contains("public static global::MetaObjects.Render.EmailDocument Render(Welcome payload", file.Content);

        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "Welcome");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var helper = asm.GetType("Acme.Generated.WelcomeEmailRenderHelper")!;
        var payloadType = asm.GetType("Acme.Generated.Welcome")!;
        var payload = Activator.CreateInstance(payloadType)!;
        payloadType.GetProperty("name")!.SetValue(payload, "Ada");

        var provider = new FilesystemProvider(templateRoot);
        var render = helper.GetMethod("Render")!;
        var email = (EmailDocument)render.Invoke(null, new object[] { payload, provider })!;
        Assert.Equal("Hi Ada", email.Subject);
        Assert.Equal("<p>Hello Ada</p>", email.HtmlBody);
        Assert.Equal("Hello Ada", email.TextBody);
    }

    [Fact]
    public void Email_without_textBodyRef_emits_null_textbody()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Welcome", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "WelcomeEmail", "@kind": "email",
                                  "@subjectRef": "email/subject", "@htmlBodyRef": "email/html",
                                  "@payloadRef": "Welcome" } }
        ]}}
        """;
        var root = Load(m);
        var templateRoot = TemplateRoot(
            ("email/subject", "Hi {{name}}"),
            ("email/html", "<p>Hello {{name}}</p>"));

        var file = Assert.Single(new RenderHelperGenerator(templateRoot).Generate(Ctx(root)));
        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "Welcome");
        var asm = CompileToAssembly(file.Content, payloadSrc);

        var helper = asm.GetType("Acme.Generated.WelcomeEmailRenderHelper")!;
        var payloadType = asm.GetType("Acme.Generated.Welcome")!;
        var payload = Activator.CreateInstance(payloadType)!;
        payloadType.GetProperty("name")!.SetValue(payload, "Ada");

        var email = (EmailDocument)helper.GetMethod("Render")!
            .Invoke(null, new object[] { payload, new FilesystemProvider(templateRoot) })!;
        Assert.Null(email.TextBody);
    }

    // ---------------------------------------------------------------------
    // BUILD-TIME drift gate (the headline)
    // ---------------------------------------------------------------------

    [Fact]
    public void Drift_gate_FAILS_codegen_when_mustache_references_a_field_not_on_the_VO()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Welcome", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "WelcomePage", "@kind": "document", "@format": "html",
                                  "@textRef": "pages/welcome", "@payloadRef": "Welcome" } }
        ]}}
        """;
        var root = Load(m);
        // {{missing}} is NOT on the Welcome VO → build must fail.
        var templateRoot = TemplateRoot(("pages/welcome", "Hi {{missing}}"));

        var ex = Assert.ThrowsAny<Exception>(() =>
            new RenderHelperGenerator(templateRoot).Generate(Ctx(root)).ToList());
        Assert.Contains("render-helper drift", ex.Message);
        Assert.Contains("WelcomePage", ex.Message);
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, ex.Message);
        Assert.Contains("missing", ex.Message);
    }

    [Fact]
    public void Drift_gate_FAILS_codegen_when_a_referenced_mustache_is_unresolvable()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Welcome", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "WelcomePage", "@kind": "document", "@format": "html",
                                  "@textRef": "pages/welcome", "@payloadRef": "Welcome" } }
        ]}}
        """;
        var root = Load(m);
        var templateRoot = TemplateRoot(); // no mustache for pages/welcome

        var ex = Assert.ThrowsAny<Exception>(() =>
            new RenderHelperGenerator(templateRoot).Generate(Ctx(root)).ToList());
        Assert.Contains("render-helper drift", ex.Message);
        Assert.Contains("unresolved", ex.Message);
    }

    [Fact]
    public void Drift_gate_does_NOT_throw_for_a_clean_template()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Welcome", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "WelcomePage", "@kind": "document", "@format": "html",
                                  "@textRef": "pages/welcome", "@payloadRef": "Welcome" } }
        ]}}
        """;
        var root = Load(m);
        var templateRoot = TemplateRoot(("pages/welcome", "Hello {{name}}"));
        // Should not throw, and should emit one file.
        var files = new RenderHelperGenerator(templateRoot).Generate(Ctx(root)).ToList();
        Assert.Single(files);
    }

    // ---------------------------------------------------------------------
    // Nested @objectRef resolved by BARE short-name (cross-port consensus)
    // ---------------------------------------------------------------------

    [Fact]
    public void Nested_objectRef_field_tree_resolves_by_bare_short_name()
    {
        // The payload VO references a nested VO by a PACKAGE-QUALIFIED ref; the field
        // tree must resolve it by bare short-name so {{author.name}} verifies clean.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Author", "children": [ { "field.string": { "name": "name" } } ] } },
          { "object.value": { "name": "Post", "children": [
            { "field.string": { "name": "title" } },
            { "field.object": { "name": "author", "@objectRef": "acme::ai::Author" } }
          ]}},
          { "template.output": { "name": "PostPage", "@kind": "document", "@format": "html",
                                  "@textRef": "pages/post", "@payloadRef": "Post" } }
        ]}}
        """;
        var root = Load(m);
        var templateRoot = TemplateRoot(("pages/post", "{{title}} by {{#author}}{{name}}{{/author}}"));

        // Clean — must not throw despite the package-qualified @objectRef.
        var file = Assert.Single(new RenderHelperGenerator(templateRoot).Generate(Ctx(root)));
        // The baked verify literal carries the nested author subtree.
        Assert.Contains("author", file.Content);
        Assert.Contains("name", file.Content);
    }

    // ---------------------------------------------------------------------
    // Roslyn compile-run harness (mirrors Fr010CodegenTests)
    // ---------------------------------------------------------------------

    private static Assembly CompileToAssembly(params string[] sources)
    {
        var trees = sources.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        // The generated render helper references the render engine.
        refs.Add(MetadataReference.CreateFromFile(typeof(Renderer).Assembly.Location));

        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary);
        var comp = CSharpCompilation.Create("rh_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
