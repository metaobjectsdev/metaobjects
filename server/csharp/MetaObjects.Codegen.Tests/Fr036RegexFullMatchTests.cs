using System.ComponentModel.DataAnnotations;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// FR-036 Pin-2 (C# port) — the emitted <c>[RegularExpression]</c> for a
/// <c>validator.regex</c> must be a FULL match, anchored as <c>^(?:…)$</c>.
///
/// .NET's <see cref="RegularExpressionAttribute"/> is valid only when the match starts at
/// index 0 AND spans the whole value. For an UNanchored ordered alternation whose earlier
/// branch is a prefix of a later one (e.g. <c>(a|ab)</c>) the engine matches the shorter
/// branch ("a", length 1) and the length check REJECTS the full string "ab" — a string the
/// anchored TS/Python (<c>^(?:…)$</c>) and Java/Kotlin (<c>Matcher.matches</c>) ports ACCEPT.
/// Anchoring forces the .NET engine to backtrack to a full match, restoring cross-port parity.
/// </summary>
public sealed class Fr036RegexFullMatchTests
{
    // An ordered alternation whose first branch ("a") is a prefix of the second ("ab") —
    // the exact shape that exposed the divergence. Authored UN-anchored.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "code", "children": [
          { "validator.regex": { "@pattern": "(a|ab)" } }
        ]}},
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static string GenerateWidget()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "regex.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        return new EntityGenerator().Generate(ctx).Single().Content;
    }

    [Fact]
    public void Emitted_regular_expression_is_anchored_full_match()
    {
        var src = GenerateWidget();
        // The generator ALWAYS wraps the authored pattern as ^(?:…)$.
        Assert.Contains("[RegularExpression(\"^(?:(a|ab))$\")]", src);
        // The bare, unanchored form must NOT be emitted.
        Assert.DoesNotContain("[RegularExpression(\"(a|ab)\")]", src);
    }

    [Fact]
    public void Anchored_pattern_accepts_the_longer_ordered_alternation_branch()
    {
        // The EXACT .NET code path the generated attribute runs at request time.
        var anchored = new RegularExpressionAttribute("^(?:(a|ab))$");
        Assert.True(anchored.IsValid("ab"), "anchored ^(?:(a|ab))$ must accept the full string \"ab\"");
        Assert.True(anchored.IsValid("a"), "anchored ^(?:(a|ab))$ must accept \"a\"");
        Assert.False(anchored.IsValid("abc"), "anchored ^(?:(a|ab))$ must reject a partial/over-long match");
        Assert.False(anchored.IsValid("xab"), "anchored ^(?:(a|ab))$ must reject a leading-junk match");

        // Documents the bug the anchor fixes: the UNanchored form wrongly rejects "ab".
        var unanchored = new RegularExpressionAttribute("(a|ab)");
        Assert.False(unanchored.IsValid("ab"),
            "unanchored (a|ab) matches only the prefix \"a\" (length 1 != 2) → .NET rejects \"ab\"");
    }
}
