using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>ADR-0061: the C# port renders Mustache only and refuses a Jinja body by name.</summary>
public sealed class TemplateEngineTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("fp-jinja-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private void Write(string rel, string text)
    {
        var full = Path.Combine(_root, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, text);
    }

    [Fact]
    public void A_jinja_only_ref_is_refused_with_the_code()
    {
        Write("g/s.j2", "{{ name }}");
        var e = Assert.Throws<RenderException>(() => new FilesystemProvider(_root).Resolve("g/s"));
        Assert.StartsWith($"{TemplateEngines.ErrTemplateEngineUnsupported}: g/s.j2", e.Message);
    }

    [Fact]
    public void A_mustache_body_beside_a_jinja_one_still_resolves()
    {
        Write("g/s.mustache", "M");
        Write("g/s.jinja", "J");
        Assert.Equal("M", new FilesystemProvider(_root).Resolve("g/s"));
        Assert.Null(new FilesystemProvider(_root).Resolve("g/none"));
    }

    [Fact]
    public void A_mustache_partial_that_is_jinja_only_is_a_finding_not_a_crash()
    {
        Write("g/footer.jinja", "{{ name }}");
        var errors = Verify.Check("{{> g/footer}}", [new PayloadField("name")],
            new VerifyOptions { Provider = new FilesystemProvider(_root) });
        Assert.Equal([new VerifyError(TemplateEngines.ErrTemplateEngineUnsupported, "g/footer")], errors);
    }

    [Fact]
    public void A_jinja_extension_is_refused()
    {
        var e = Assert.Throws<RenderException>(() => new FilesystemProvider(_root, ".Jinja2"));
        Assert.StartsWith(TemplateEngines.ErrTemplateEngineUnsupported, e.Message);
    }
}
