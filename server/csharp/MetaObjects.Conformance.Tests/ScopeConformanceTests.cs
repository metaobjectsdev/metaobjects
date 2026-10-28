// Runs the shared scope corpus against this port. Reads the single committed
// fixtures/scope-conformance/cases.json — no per-port fixture. The corpus is the
// contract; server/typescript/packages/metadata/src/scope.ts is the reference it was
// authored against.
using System.Text.Json;
using MetaObjects;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ScopeConformanceTests
{
    private static JsonElement Cases()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var path = Path.Combine(dir!.FullName, "fixtures", "scope-conformance", "cases.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty("cases").Clone();
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in Cases().EnumerateArray()) data.Add(c.GetProperty("name").GetString()!);
        return data;
    }

    private static List<string> Strings(JsonElement scope, string key) =>
        scope.TryGetProperty(key, out var arr)
            ? arr.EnumerateArray().Select(e => e.GetString()!).ToList()
            : [];

    [Fact]
    public void CorpusIsNotEmpty() =>
        // Guards against a runner that silently reads nothing; the corpus grows, so no
        // hard-coded count.
        Assert.NotEmpty(CaseNames());

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void CorpusCaseMatchesTheReference(string name)
    {
        var c = Cases().EnumerateArray().Single(x => x.GetProperty("name").GetString() == name);
        var scope = c.GetProperty("scope");
        var compiled = Scope.CompileScope(Strings(scope, "include"), Strings(scope, "exclude"));
        foreach (var exp in c.GetProperty("expect").EnumerateArray())
        {
            var fqn = exp.GetProperty("fqn").GetString()!;
            Assert.True(
                exp.GetProperty("matches").GetBoolean() == Scope.MatchesScope(fqn, compiled),
                $"{name}: {fqn}");
        }
    }

    // --- Pattern errors: not in the corpus (which is matches-only), so pinned here ---

    [Theory]
    [InlineData("")]
    [InlineData("acme::::Order")]
    [InlineData("::Order")]
    [InlineData("acme::")]
    [InlineData("acme:::Order")]
    [InlineData("acme:Order")]
    public void AnInvalidPatternIsRefusedWithItsCode(string pattern)
    {
        var ex = Assert.Throws<MetaModelException>(() => Scope.CompilePattern(pattern));
        Assert.Equal(ErrorCode.ERR_SCOPE_PATTERN_INVALID, ex.Code);
    }

    [Fact]
    public void ATrailingNewlineInTheNameNeverMatches()
    {
        var compiled = Scope.CompileScope(["acme::Order"]);
        Assert.True(Scope.MatchesScope("acme::Order", compiled));
        Assert.False(Scope.MatchesScope("acme::Order\n", compiled));
    }

    [Fact]
    public void AStarAdjacentToAMetacharacterKeepsTheLiteral()
    {
        var compiled = Scope.CompileScope(["acme::a*.b", "acme::(x)*"]);
        Assert.True(Scope.MatchesScope("acme::aXY.b", compiled));
        Assert.False(Scope.MatchesScope("acme::aXYxb", compiled));
        Assert.True(Scope.MatchesScope("acme::(x)tail", compiled));
        Assert.True(Scope.MatchesScope("acme::(x)", compiled));
    }
}
