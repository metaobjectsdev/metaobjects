using MetaObjects.Cli;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// With no <c>--template-root</c>, template refs resolve under <c>prompts/</c> when that
/// directory exists and under <c>templates/</c> otherwise.
/// <para>
/// The two halves of the toolchain disagreed about this name. The Node CLI has always
/// defaulted to <c>prompts</c> (<c>DEFAULT_PROMPTS_DIR</c>), while this port and the
/// Python one defaulted to <c>templates</c>, so a project laid out the way the Node CLI
/// describes — which this repo's own adopter estate is — had a <c>gen</c> looking
/// somewhere its bodies were not.
/// </para>
/// <para>
/// A FALLBACK, not a flip, and the second test is the half that says so: a project with
/// only <c>templates/</c> must still answer <c>templates</c>. That is what makes the
/// change shippable in a PATCH — nothing moves for a project that exists today.
/// </para>
/// <para>
/// The rule is defined relative to the CURRENT directory — the same base the provider
/// resolves against — so these pass the scratch directory in explicitly rather than
/// moving the process CWD: xUnit runs collections in parallel, and a test that moved the
/// CWD would be changing it under every other class at once.
/// </para>
/// </summary>
public sealed class DefaultTemplateRootTests : IDisposable
{
    private readonly string _tmp =
        Path.Combine(Path.GetTempPath(), "meta-troot-" + Guid.NewGuid().ToString("N"));

    public DefaultTemplateRootTests() => Directory.CreateDirectory(_tmp);

    public void Dispose()
    {
        try { Directory.Delete(_tmp, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void Prefers_prompts_when_it_exists()
    {
        Directory.CreateDirectory(Path.Combine(_tmp, GenCommand.DefaultPromptsDir));
        Directory.CreateDirectory(Path.Combine(_tmp, GenCommand.LegacyTemplatesDir));

        Assert.Equal(GenCommand.DefaultPromptsDir, GenCommand.DefaultTemplateRoot(_tmp));
    }

    [Fact]
    public void Falls_back_to_templates_when_prompts_is_absent()
    {
        Directory.CreateDirectory(Path.Combine(_tmp, GenCommand.LegacyTemplatesDir));

        Assert.Equal(GenCommand.LegacyTemplatesDir, GenCommand.DefaultTemplateRoot(_tmp));
    }

    [Fact]
    public void Answers_templates_when_neither_exists()
    {
        // Not a special case — the fallback is unconditional, so a project with no
        // bodies at all still gets the name the error message will quote.
        Assert.Equal(GenCommand.LegacyTemplatesDir, GenCommand.DefaultTemplateRoot(_tmp));
    }

    [Fact]
    public void Returns_a_name_relative_to_the_current_directory_not_an_absolute_path()
    {
        // The provider resolves what this returns against the CURRENT directory. An
        // absolute path anchored anywhere else would resolve correctly here and wrongly
        // for a caller invoked from another directory.
        Directory.CreateDirectory(Path.Combine(_tmp, GenCommand.DefaultPromptsDir));

        Assert.False(Path.IsPathRooted(GenCommand.DefaultTemplateRoot(_tmp)));
    }
}
