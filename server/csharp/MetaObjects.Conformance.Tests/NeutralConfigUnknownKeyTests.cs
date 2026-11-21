using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MetaObjects;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// An unknown top-level key in <c>.metaobjects/config.json</c> warns and is ignored, as in TypeScript's
/// <c>loadConfig</c>: the file is shared by every port and version, so a key a newer MetaObjects wrote
/// must not fail the load, while a misspelling is named. A key inside a block this port owns stays
/// refused. The oracle is TypeScript's behaviour and its warning text (<c>sdk/src/config.ts</c>).
/// </summary>
public sealed class NeutralConfigUnknownKeyTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-cfg-unknown-" + Guid.NewGuid().ToString("N"));
    private readonly List<string> _warnings = [];
    private readonly Action<string> _previous;

    public NeutralConfigUnknownKeyTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        _previous = NeutralConfig.WarningSink;
        // Other test classes may read their own configs meanwhile: keep only this project's lines.
        NeutralConfig.WarningSink = m => { lock (_warnings) if (m.Contains(_root, StringComparison.Ordinal)) _warnings.Add(m); };
    }

    public void Dispose()
    {
        NeutralConfig.WarningSink = _previous;
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    private void WriteConfig(string json) => File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), json);

    [Fact]
    public void An_unknown_top_level_key_warns_once_naming_it_and_the_load_succeeds()
    {
        WriteConfig("{\"schema_version\":1,\"scopes\":{\"include\":[]},\"futureKey\":1}");

        Assert.NotNull(NeutralConfig.Read(_root));
        Assert.NotNull(NeutralConfig.Read(_root));

        Assert.Equal(2, _warnings.Count);
        var scopes = Assert.Single(_warnings, w => w.Contains("\"scopes\"", StringComparison.Ordinal));
        Assert.StartsWith("warning: ", scopes);
        Assert.Contains("unknown top-level key \"scopes\" ignored", scopes);
        Assert.Contains("remove the key if it is a misspelling", scopes);
        Assert.Contains("Known keys: schema_version,", scopes);
        Assert.Contains(" scope,", scopes);
        Assert.Single(_warnings, w => w.Contains("unknown top-level key \"futureKey\" ignored", StringComparison.Ordinal));
    }

    [Fact]
    public void Keys_TypeScript_owns_are_not_unknown()
    {
        // Keys this port never reads but TypeScript's schema declares: not a typo, no warning.
        WriteConfig("{\"schema_version\":1,\"pending_in_git\":true,\"confidence_thresholds\":{},\"extract\":{}," +
                    "\"scope\":{\"exclude\":[]},\"migrate\":{\"dialect\":\"postgres\"}}");

        Assert.NotNull(NeutralConfig.Read(_root));

        Assert.Empty(_warnings);
    }

    [Fact]
    public void An_unknown_key_inside_a_block_this_port_owns_is_still_refused()
    {
        WriteConfig("{\"schema_version\":1,\"csharp\":{\"outDirr\":\"Generated\"}}");

        var ex = Assert.Throws<MetaModelException>(() => NeutralConfig.Read(_root));
        Assert.Contains("\"csharp\" has an unknown key \"outDirr\"", ex.Message);
    }
}
