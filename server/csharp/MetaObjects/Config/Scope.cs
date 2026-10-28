// FR-023 §4.3 — the scope-pattern grammar: whether a fully-qualified node name falls
// inside a consumer's declared `include`/`exclude` scope.
//
// A pure, no-I/O port of server/typescript/packages/metadata/src/scope.ts
// (compilePattern / compileScope / matchesScope). The shared corpus
// fixtures/scope-conformance/cases.json pins the semantics, so behavior must match the
// reference exactly:
//
//   `*` inside a segment matches any run of characters but never crosses a `::`.
//   A segment that is exactly `**` matches one or more whole segments.
//   Every other character is literal, regex metacharacters included.
//   An absent or empty `include` means everything; `exclude` is applied after it.
//   Matching is case-sensitive.
using System.Text;
using System.Text.RegularExpressions;

namespace MetaObjects.Config;

/// <summary>A compiled scope. Every pattern is already anchored to the whole name.</summary>
public sealed record CompiledScope(IReadOnlyList<Regex> Include, IReadOnlyList<Regex> Exclude);

public static class Scope
{
    /// <summary>One package segment: any run of characters containing no separator char.</summary>
    private const string Segment = "[^:]+";

    /// <summary>One or more segments, separator-joined — the <c>**</c> expansion.</summary>
    private const string Segments = Segment + "(?:" + PACKAGE_SEPARATOR + Segment + ")*";

    /// <summary>Regex metacharacters escaped for literal matching; mirrors the reference's class.</summary>
    private const string Metacharacters = ".*+?^${}()|[]\\";

    private static string EscapeLiteral(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var c in text)
        {
            if (Metacharacters.Contains(c)) sb.Append('\\');
            sb.Append(c);
        }
        return sb.ToString();
    }

    private static MetaModelException Invalid(string message) =>
        new(message, ErrorCode.ERR_SCOPE_PATTERN_INVALID);

    /// <summary>Compile one segment. <c>**</c> spans segments; <c>*</c> never crosses a separator.</summary>
    private static string CompileSegment(string segment, string pattern)
    {
        if (segment.Length == 0)
            throw Invalid($"empty segment in scope pattern \"{pattern}\"");
        // A segment surviving the split on "::" can still hold a lone ":" when the pattern
        // has an odd colon run ("acme:::Order" splits to "acme", ":Order"). Treating it as
        // literal would compile a pattern no legal name can match, so it is refused loudly
        // instead of silently matching nothing.
        if (segment.Contains(':'))
            throw Invalid(
                $"scope pattern \"{pattern}\" has a malformed separator (an odd run of \":\")" +
                " — segments are joined by \"::\", never a single \":\"");
        if (segment == "**") return $"(?:{Segments})";
        // `*` inside a segment matches any characters except the separator char.
        return string.Join("[^:]*", segment.Split('*').Select(EscapeLiteral));
    }

    public static Regex CompilePattern(string pattern)
    {
        if (pattern.Length == 0) throw Invalid("scope pattern must not be empty");
        var body = string.Join(
            PACKAGE_SEPARATOR,
            pattern.Split(PACKAGE_SEPARATOR).Select(s => CompileSegment(s, pattern)));
        // \A ... \z, not ^ ... $: .NET's `$` also matches before a trailing newline, which
        // the reference's anchored regex never does.
        return new Regex($@"\A{body}\z", RegexOptions.CultureInvariant);
    }

    /// <summary>Absent (<c>null</c>) or empty <c>include</c> means "everything".</summary>
    public static CompiledScope CompileScope(
        IEnumerable<string>? include = null, IEnumerable<string>? exclude = null) =>
        new(
            (include ?? []).Select(CompilePattern).ToList(),
            (exclude ?? []).Select(CompilePattern).ToList());

    /// <summary>True when <paramref name="fqn"/> is inside the scope. An empty <c>include</c> means everything.</summary>
    public static bool MatchesScope(string fqn, CompiledScope compiled)
    {
        var included = compiled.Include.Count == 0 || compiled.Include.Any(re => re.IsMatch(fqn));
        if (!included) return false;
        return !compiled.Exclude.Any(re => re.IsMatch(fqn));
    }
}
