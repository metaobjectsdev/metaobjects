using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// End-to-end `dotnet meta verify`: a metadata dir + a filesystem templates dir, run
/// through VerifyCommand.Run. Proves the build-time drift gate catches a template
/// variable the payload doesn't declare, and passes a clean template.
/// </summary>
public sealed class VerifyCommandTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-verify-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string TplDir => Path.Combine(_tmp, "templates");

    // object.value Payload { name } + template.prompt greeting -> Payload, @textRef t/main
    private const string Metadata = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "name" } } ] } },
      { "template.prompt": { "name": "greeting", "@payloadRef": "Payload", "@textRef": "t/main", "@format": "text" } }
    ]}}
    """;

    public VerifyCommandTests()
    {
        Directory.CreateDirectory(MetaDir);
        Directory.CreateDirectory(TplDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), Metadata);
    }

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch { /* best effort */ }
    }

    private void WriteTemplate(string body)
    {
        var dir = Path.Combine(TplDir, "t");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "main.mustache"), body);
    }

    // Write a template body at an arbitrary 2-layer ref (group/source) → <ref>.mustache.
    private void WriteAt(string reference, string body)
    {
        var full = Path.Combine(TplDir,
            reference.Replace('/', Path.DirectorySeparatorChar) + ".mustache");
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, body);
    }

    [Fact]
    public void Clean_template_passes()
    {
        WriteTemplate("Hi {{name}}.");
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.True(o.Ok, string.Join("; ",
            o.LoadErrors.Concat(o.UnresolvedText).Concat(o.Errors.Select(e => $"{e.Code}({e.Path})"))));
        Assert.Empty(o.Errors);
    }

    [Fact]
    public void Drifted_variable_is_caught()
    {
        WriteTemplate("Hi {{name}}, you have {{notAField}}.");
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.Contains(o.Errors, d => d.Code == Render.Verify.ERR_VAR_NOT_ON_PAYLOAD && d.Path == "notAField");
    }

    [Fact]
    public void Unresolved_textref_fails()
    {
        // No template file written → @textRef "t/main" does not resolve.
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.NotEmpty(o.UnresolvedText);
    }

    [Fact]
    public void Missing_required_tag_is_caught()
    {
        // Override the metadata with a template that contracts a <answer> output tag.
        const string tagged = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.prompt": { "name": "greeting", "@payloadRef": "Payload", "@textRef": "t/main", "@requiredTags": ["answer"] } }
        ]}}
        """;
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), tagged);
        WriteTemplate("Hi {{name}}."); // references the var cleanly but omits the <answer> tag
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.Contains(o.Errors, d => d.Code == Render.Verify.ERR_OUTPUT_TAG_MISSING && d.Path == "answer");
    }

    [Fact]
    public void Prompt_findings_are_tagged_with_prompt_kind()
    {
        WriteTemplate("Hi {{notAField}}.");
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.All(o.Errors, d => Assert.Equal(VerifyCommand.KIND_PROMPT, d.Kind));
    }

    // -------------------- template.output (FR6, ADR-0010) --------------------

    [Fact]
    public void Output_document_body_passes_when_clean()
    {
        // A document template.output's @textRef body is drift-checked (parity with
        // prompt, #193): a clean body referencing only payload fields passes.
        const string outputModel = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "NpcResponsePayload", "children": [
            { "field.string": { "name": "name" } },
            { "field.int":    { "name": "age" } }
          ]}},
          { "template.output": { "name": "NpcResponseOutput", "@format": "json",
            "@payloadRef": "NpcResponsePayload", "@textRef": "npc/output" } }
        ]}}
        """;
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), outputModel);
        WriteAt("npc/output", "{{name}} is {{age}}");
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.True(o.Ok, string.Join("; ",
            o.LoadErrors.Concat(o.UnresolvedText).Concat(o.Errors.Select(e => $"{e.Kind}/{e.Code}({e.Path})"))));
    }

    // ---------- #193: template.output bodies are drift-checked (parity with prompt) ----------

    private const string EmailModel = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "P", "children": [ { "field.string": { "name": "name" } } ] } },
      { "template.output": { "name": "Welcome", "@kind": "email",
        "@payloadRef": "P", "@subjectRef": "e/subj", "@htmlBodyRef": "e/html" } }
    ]}}
    """;

    [Fact]
    public void Output_email_clean_passes()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EmailModel);
        WriteAt("e/subj", "Hello {{name}}");
        WriteAt("e/html", "<p>Hi {{name}}</p>");
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.True(o.Ok, string.Join("; ",
            o.LoadErrors.Concat(o.UnresolvedText).Concat(o.Errors.Select(e => $"{e.Kind}/{e.Code}({e.Path})"))));
    }

    [Fact]
    public void Output_email_body_drift_is_caught()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), EmailModel);
        WriteAt("e/subj", "Hello {{name}}");
        WriteAt("e/html", "<p>Hi {{nope}}</p>"); // {{nope}} is not on payload P
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.Contains(o.Errors, d =>
            d.Kind == VerifyCommand.KIND_OUTPUT &&
            d.Code == Render.Verify.ERR_VAR_NOT_ON_PAYLOAD &&
            d.Path == "nope");
    }

    [Fact]
    public void Output_document_body_drift_is_caught()
    {
        const string docModel = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "P", "children": [ { "field.string": { "name": "name" } } ] } },
          { "template.output": { "name": "Doc", "@format": "json", "@payloadRef": "P", "@textRef": "t/main" } }
        ]}}
        """;
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), docModel);
        WriteTemplate("spec for {{nope}}"); // {{nope}} is not on payload P → document-body drift
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.Contains(o.Errors, d =>
            d.Kind == VerifyCommand.KIND_OUTPUT &&
            d.Code == Render.Verify.ERR_VAR_NOT_ON_PAYLOAD &&
            d.Path == "nope");
    }

    [Fact]
    public void Output_with_unresolved_payload_ref_is_flagged_as_output_drift()
    {
        // The @payloadRef names an object.value that doesn't exist.
        const string outputModel = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "RealPayload", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.output": { "name": "OutputOne", "@format": "json",
            "@payloadRef": "NoSuchPayload", "@textRef": "x/y" } }
        ]}}
        """;
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), outputModel);
        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.False(o.Ok);
        Assert.Contains(o.Errors, d =>
            d.Kind == VerifyCommand.KIND_OUTPUT &&
            d.Code == VerifyCommand.ERR_PAYLOAD_REF_UNRESOLVED &&
            d.Path == "NoSuchPayload");
    }

    // #228 — the build-time @payloadRef resolver bug class (cross-port checkpoint for this
    // task). Two packages each declare their OWN bare-colliding "Report" and a template.output
    // with a BARE (same-package) @payloadRef "Report" — the realistic common case (a template
    // referencing its own package's local value-object). Before this fix,
    // PayloadCodegen.BuildPayloadFieldTree had no referrer-package parameter and resolved via a
    // GLOBAL bare-name-first-match scan, so ONE of these two templates' drift check would
    // silently bind to the OTHER package's "Report" (load-order dependent) and spuriously fail
    // with ERR_VAR_NOT_ON_PAYLOAD for its own field. Passing each template's own effective
    // package now binds each to ITS OWN "Report".
    [Fact]
    public void Bare_payloadRef_collision_across_packages_binds_own_package_report()
    {
        const string alphaModel = """
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Report", "children": [ { "field.string": { "name": "alphaVal" } } ] } },
          { "template.output": { "name": "ReportDocAlpha", "@payloadRef": "Report",
              "@textRef": "t/alpha", "@format": "json" } }
        ]}}
        """;
        const string betaModel = """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Report", "children": [ { "field.string": { "name": "betaVal" } } ] } },
          { "template.output": { "name": "ReportDocBeta", "@payloadRef": "Report",
              "@textRef": "t/beta", "@format": "json" } }
        ]}}
        """;
        File.WriteAllText(Path.Combine(MetaDir, "meta.ai.json"), alphaModel);
        File.WriteAllText(Path.Combine(MetaDir, "meta.beta.json"), betaModel);
        WriteAt("t/alpha", "{{alphaVal}}");
        WriteAt("t/beta", "{{betaVal}}");

        var o = VerifyCommand.Run(MetaDir, TplDir);
        Assert.True(o.Ok, string.Join("; ",
            o.LoadErrors.Concat(o.UnresolvedText).Concat(o.Errors.Select(e => $"{e.Code}({e.Path})"))));
        Assert.Empty(o.Errors);
    }
}
