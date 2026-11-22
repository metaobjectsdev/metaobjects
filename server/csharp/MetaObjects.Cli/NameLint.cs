// `dotnet meta verify` — the node-name AUTHORING lint.
//
// The loader accepts any string as a node `name`, on every port. An adopter's metadata carried a
// field named "defaultCurrencyId " (a trailing space, copied from legacy XML); it loaded with no error.
//
// WHY THIS IS A WARNING AND NOT A LOAD ERROR. A whitespace name WORKS today on the core path
// (`meta migrate` quotes the column, the ObjectManager round-trips the key), so refusing it at load
// would break metadata that does what its author asked (docs/compatibility-policy.md). Nothing here
// reaches an exit code.
//
// REQUIREMENTS ARE NOT LINTED HERE: a requirement's name is its dotted address, and the requirement
// lint owns it.
//
// Mirrors the TS reference (server/typescript/packages/cli/src/lib/name-lint.ts). The codes, the
// message text and the fixtures are shared: fixtures/model-lint-conformance/.

using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;

namespace MetaObjects.Cli;

/// <summary>The advisory node-name lint <c>dotnet meta verify</c> runs on every invocation.</summary>
public static class NameLint
{
    /// <summary>Leading or trailing whitespace — the strong finding.</summary>
    public const string WARN_NAME_SURROUNDING_WHITESPACE = "WARN_NAME_SURROUNDING_WHITESPACE";
    /// <summary>Whitespace inside an otherwise trimmed name — the plain advisory.</summary>
    public const string WARN_NAME_INTERNAL_WHITESPACE = "WARN_NAME_INTERNAL_WHITESPACE";

    /// <summary>Opt-out environment variable, beside <c>--no-name-lint</c> (Node <c>meta</c> parity).</summary>
    public const string EnvOptOut = "META_NO_NAME_LINT";

    /// <summary>
    /// What counts as whitespace: EXACTLY the ECMAScript <c>\s</c> class (the set
    /// <c>String.prototype.trim</c> strips), so every port reports the same names. .NET's
    /// <c>char.IsWhiteSpace</c> and regex <c>\s</c> differ from it (they include U+0085 and
    /// U+001C–U+001F, and omit U+FEFF), so the class is spelled out.
    /// </summary>
    private static readonly char[] Whitespace =
    [
        '\t', '\n', '\v', '\f', '\r', ' ', '\u00A0', '\u1680',
        '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A',
        '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF',
    ];

    private static bool HasWhitespace(string name) => name.IndexOfAny(Whitespace) >= 0;

    /// <summary>One segment of a node's address, quoted when it has whitespace so the whitespace stays visible.</summary>
    private static string Segment(string name) => HasWhitespace(name) ? LintText.Quote(name) : name;

    /// <summary>Lint the name of every named node in the loaded model, requirements excepted.</summary>
    public static List<LintFinding> Lint(MetaData root)
    {
        var findings = new List<LintFinding>();
        Walk(root, "", findings);
        return findings;
    }

    private static void Walk(MetaData node, string prefix, List<LintFinding> findings)
    {
        // OWN-ONLY (ADR-0039 sanctioned case): report each DECLARATION once, at the node that
        // declares it. The resolving Children() would repeat an inherited field on every subtype.
        foreach (var child in node.OwnChildren())
        {
            if (child.Type == TYPE_REQUIREMENT) continue; // owned by the requirement lint — see the header
            var path = prefix == "" ? TopLevelAddress(child) : $"{prefix}.{Segment(child.Name)}";
            Check(child, path, findings);
            Walk(child, path, findings);
        }
    }

    /// <summary>A root-level node's address, package-qualified the way <c>ResolutionKey()</c> is.</summary>
    private static string TopLevelAddress(MetaData node)
    {
        var pkg = node.Package ?? node.FileDefaultPackage;
        return string.IsNullOrEmpty(pkg) ? Segment(node.Name) : $"{pkg}{PACKAGE_SEPARATOR}{Segment(node.Name)}";
    }

    private static void Check(MetaData node, string path, List<LintFinding> findings)
    {
        var name = node.Name;
        if (name == "" || !HasWhitespace(name)) return;
        var kind = $"{node.Type}.{node.SubType}";
        var quoted = LintText.Quote(name);
        // @column is a FIELD attribute: advising an object author to pin it would send them looking
        // for a slot that does not exist on the node.
        var pin = node.Type == TYPE_FIELD ? ", and pin @column if the physical column must keep its name" : "";
        var trimmed = name.Trim(Whitespace);
        if (trimmed != name)
        {
            var inner = HasWhitespace(trimmed) ? " It also contains whitespace inside it." : "";
            var target = trimmed == "" ? "" : $" (to {LintText.Quote(trimmed)}, presumably)";
            findings.Add(new LintFinding(
                WARN_NAME_SURROUNDING_WHITESPACE, path,
                $"{kind} name {quoted} has leading or trailing whitespace, which is almost certainly unintended — " +
                $"rename it{target}{pin}. The whitespace is carried into every identifier, column and wire key " +
                $"derived from the name.{inner}"));
            return;
        }
        findings.Add(new LintFinding(
            WARN_NAME_INTERNAL_WHITESPACE, path,
            $"{kind} name {quoted} contains whitespace. A name is an identifier: derived column names and wire " +
            $"keys carry the space, and generated code cannot use it as one. Consider renaming it{pin}."));
    }
}
