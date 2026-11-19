using System.IO;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// ADR-0066 — the <c>rules</c> and <c>verify</c> blocks of <c>config.json</c>. An absent key takes
/// its default, which behaves as before the blocks existed; a mistake is refused rather than
/// silently defaulted, because a defaulted typo would change what <c>verify</c> reports.
/// </summary>
public sealed class NeutralConfigRulesTests
{
    private static RulesSettings Read(string extraJson)
    {
        var dir = Path.Combine(Path.GetTempPath(), "neutral-config-rules-" + System.Guid.NewGuid().ToString("N"));
        var cfgDir = Path.Combine(dir, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        var comma = extraJson.Length == 0 ? "" : ", ";
        File.WriteAllText(Path.Combine(cfgDir, "config.json"), "{ \"schema_version\": 1" + comma + extraJson + " }");
        try
        {
            return NeutralConfig.Read(dir)!.Rules;
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void AbsentKeys_TakeTheDefaults()
    {
        Assert.Equal(new RulesSettings("derive", "initial", "unclaimed", "warn"), Read(""));
    }

    [Fact]
    public void EveryKey_IsRead()
    {
        var settings = Read("""
            "rules": { "permissions": { "names": "require" }, "lifecycle": { "create": "any", "commands": "none" } },
            "verify": { "handEdits": "fail", "lifecycle": { "unreachable": "error" } }
            """);
        Assert.Equal(new RulesSettings("require", "any", "none", "error"), settings);
    }

    [Theory]
    [InlineData("""
        "rules": { "permission": { "names": "advise" } }
        """)]
    [InlineData("""
        "rules": { "lifecycle": { "initial": "any" } }
        """)]
    [InlineData("""
        "rules": { "permissions": { "names": "strict" } }
        """)]
    [InlineData("""
        "rules": { "lifecycle": { "commands": true } }
        """)]
    [InlineData("""
        "rules": "advise"
        """)]
    [InlineData("""
        "verify": { "lifecycle": { "unreachable": "fail" } }
        """)]
    [InlineData("""
        "verify": { "lifecycles": {} }
        """)]
    [InlineData("""
        "verify": { "handEdits": "warn" }
        """)]
    public void AMistake_IsRefusedNotDefaulted(string extraJson)
    {
        var ex = Assert.Throws<MetaModelException>(() => Read(extraJson));
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
    }
}
