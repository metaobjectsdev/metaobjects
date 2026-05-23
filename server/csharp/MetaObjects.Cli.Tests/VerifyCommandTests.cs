using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// End-to-end `meta verify`: a metadata dir + a filesystem templates dir, run
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
}
