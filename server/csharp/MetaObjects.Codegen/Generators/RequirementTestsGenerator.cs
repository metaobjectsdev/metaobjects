// requirement-tests — one xUnit test per declared requirement, calling a project-owned witness (ADR-0057).
//
// For each metamodel package that holds a tested requirement this writes two files, rewritten whole on
// every run: Requirements_<pkgKey>_Witnesses.g.cs (an interface with one default member per NON-skipped
// test, which fails with `unimplemented requirement: ...`) and Requirements_<pkgKey>_Tests.g.cs (one
// [Fact] per requirement, calling the member through the interface on the project's witness class). The
// project owns the witnesses: it writes a class implementing every generated witness interface and
// implements the members it has witnesses for. A requirement that becomes live adds a failing member, a
// red test and no compile break; one that is retired or deleted removes the member.
//
// THE DRIFT SIGNAL NEEDS THE EXPLICIT FORM. A witness that implements a member EXPLICITLY
//
//     void Requirements_acme_shop_Witnesses.req_acme_shop_Orders_Recorded__object_entity() { ... }
//
// stops compiling (CS0539) once the member is removed, which is how an orphan witness is found. The same
// witness written IMPLICITLY (`public void req_...() { ... }`) is an ordinary method after the member is
// gone and goes stale silently, so the generated header tells the project to write the explicit form. A
// method that merely looks like a witness (no `public`, another return type, a parameter, `static`) is not
// an implementation: it compiles, and the default member runs and fails the test.
//
// Which tests exist, what each is called, whether it is skipped and its digest come from
// MetaObjects.Core.Requirement.RequirementTestIdentities, which every language port shares and a
// conformance corpus pins. This class decides only how they are WRITTEN. It is a reference helper
// (ADR-0034 Amendment 3): `dotnet meta eject requirement-tests` copies this one file into your project,
// and the default rendering is in it, so an owned copy changes the output freely.
//
// OPTIONS are public init properties, because this port has no per-generator option channel: the packaged
// `dotnet meta gen --generators requirement-tests` builds the generator with none set, and a project that
// wants any sets them where it constructs the generator, in its owned codegen/Program.cs:
//
//     new RequirementTestsGenerator { WitnessClass = "MyApp.Tests.Witnesses", Grain = RequirementTestGrain.Member }
//
// The generated tests are xUnit; the project that compiles them needs a reference to xunit. They import
// nothing from MetaObjects.

using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using MetaObjects.Core.Requirement;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates one xUnit test per requirement, calling a project-owned witness (ADR-0057).</summary>
public class RequirementTestsGenerator : IGenerator
{
    /// <summary>The refusal code when two tests map to one witness key.</summary>
    public const string ErrWitnessKeyCollision = "ERR_REQUIREMENT_WITNESS_KEY_COLLISION";

    /// <summary>How many uncovered requirements to name before "and N more".</summary>
    private const int MaxNamedUncovered = 5;

    private const string SkipPlanned = "planned - not built yet";
    private const string SkipRetired = "retired - the capability was deliberately removed; assert it stays removed";

    public string Name => "requirement-tests";

    /// <summary>
    /// The namespace the generated tests are written into: a dotted C# name, without <c>global::</c>. A keyword
    /// segment is escaped with <c>@</c> where it is emitted. Default: <c>&lt;run namespace&gt;.Requirements</c>,
    /// so a run with no option set needs none.
    /// </summary>
    public string? TestNamespace { get; init; }

    /// <summary>
    /// The project class that implements every generated witness interface, by its full name (it is emitted as
    /// <c>global::&lt;name&gt;</c>, so no namespace of the tests can capture it). It should implement each member
    /// EXPLICITLY; see the file comment. The generated tests construct it with <c>new</c>, so it needs a public
    /// parameterless constructor. Default:
    /// <c>&lt;run namespace&gt;.RequirementWitnesses</c>. If that class does not exist the test project does not
    /// compile: a one-time setup, and the only by-name binding is a static one (ADR-0001).
    /// </summary>
    public string? WitnessClass { get; init; }

    /// <summary>
    /// The fan-out unit: one test per distinct concern (the default) or per distinct reference. Anything else
    /// is refused, never run as a hybrid.
    /// </summary>
    public RequirementTestGrain Grain { get; init; } = RequirementTestGrain.Concern;

    /// <summary>
    /// Which requirements get a test. It REPLACES the default of functional requirements at level 4 or above;
    /// it does not narrow it.
    /// </summary>
    public IRequirementTestFilter? Filter { get; init; }

    /// <summary>Replaces the default text of individual tests; see <see cref="IRequirementTestRenderer"/>.</summary>
    public IRequirementTestRenderer? Renderer { get; init; }

    /// <summary>Name the requirements the filter excluded, once per run. Default on.</summary>
    public bool WarnUncovered { get; init; } = true;

    /// <summary>One test to write: its identity and the data its rendering is built from.</summary>
    private sealed record Planned(RequirementTestIdentity Identity, RequirementTestArgs Args);

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // The grain is checked first (Select does it), so a bad one is refused whatever the model holds.
        // Selection is the very function the identity corpus pins: this generator selects nothing itself.
        var selection = RequirementTestIdentities.Select(ctx.Root, Grain, Filter);
        // No requirement, no change: nothing is written and nothing is said.
        if (selection.RequirementCount == 0) return [];

        var testNamespace = ParsedName(nameof(TestNamespace), TestNamespace ?? ctx.Config.Namespace + ".Requirements", allowGlobal: false);
        var witnessClass = ParsedName(nameof(WitnessClass), WitnessClass ?? ctx.Config.Namespace + ".RequirementWitnesses", allowGlobal: true);

        var planned = selection.Tests
            .Select(t => new Planned(t.Identity, ArgsFor(t.Requirement.Node, t.Identity, t.Unit.Targets)))
            .ToList();
        RefuseCollisions(planned);
        if (WarnUncovered && selection.ExcludedPaths.Count > 0) ctx.Warn(UncoveredWarning(selection.ExcludedPaths));

        // One pair of files per package key. Two packages that mangle alike share a pair: their tests
        // keep distinct keys, which the collision check above has just proven.
        var byPackage = new SortedDictionary<string, List<Planned>>(StringComparer.Ordinal);
        foreach (var p in planned)
        {
            var key = PackageKey(p.Identity.Package);
            if (!byPackage.TryGetValue(key, out var group)) byPackage[key] = group = [];
            group.Add(p);
        }

        var files = new List<EmittedFile>();
        foreach (var (key, tests) in byPackage)
        {
            var witnesses = $"Requirements_{key}_Witnesses";
            var testClass = $"Requirements_{key}_Tests";
            files.Add(new EmittedFile(witnesses + ".g.cs", WitnessInterface(testNamespace, witnesses, witnessClass, tests)));
            files.Add(new EmittedFile(testClass + ".g.cs", TestClass(testNamespace, testClass, witnesses, witnessClass, tests, Renderer)));
        }
        return files;
    }

    // ------------------------------------------------------------------
    // options
    // ------------------------------------------------------------------

    /// <summary>
    /// A dotted name that is spliced into generated source: the segments without any <c>@</c>, so a comment or a
    /// message can say the name as it was written, and the spelling that is emitted as code, where a segment that
    /// is a C# keyword is escaped with <c>@</c>.
    /// </summary>
    private sealed record DottedName(IReadOnlyList<string> Segments)
    {
        public string Plain => string.Join('.', Segments);

        public string Code => string.Join('.', Segments.Select(s => Keywords.Contains(s) ? "@" + s : s));
    }

    private const string GlobalPrefix = "global::";

    /// <summary>
    /// Parse an option that names a namespace or a class. Each segment must be a legal C# identifier (non-ASCII
    /// letters included), optionally written verbatim with a leading <c>@</c>. A <c>global::</c> prefix is refused
    /// on a namespace, which cannot carry one, and accepted and removed on a class, since the generator emits
    /// <c>global::</c> itself.
    /// </summary>
    private static DottedName ParsedName(string option, string value, bool allowGlobal)
    {
        var text = value.Trim();
        if (text.StartsWith(GlobalPrefix, StringComparison.Ordinal))
        {
            if (!allowGlobal)
                throw new InvalidOperationException(
                    $"requirement-tests: {option} must not start with '{GlobalPrefix}': a namespace declaration cannot be " +
                    $"qualified. Write '{text[GlobalPrefix.Length..]}', not '{value}'.");
            text = text[GlobalPrefix.Length..];
        }
        var segments = text.Split('.').Select(s => s.StartsWith('@') ? s[1..] : s).ToList();
        if (!segments.All(IsIdentifier))
            throw new InvalidOperationException(
                $"requirement-tests: {option} must be a dotted C# name, not '{value}'. Set it on the generator " +
                "(new RequirementTestsGenerator { " + option + " = \"...\" }); its default is derived from the run namespace.");
        return new DottedName(segments);
    }

    /// <summary>
    /// A C# identifier: a letter, a letter number or <c>_</c>, then those and combining marks, decimal digits,
    /// connector punctuation and formatting characters (ECMA-334, "Identifiers"). The check is by Unicode category,
    /// so a legal non-ASCII name is accepted.
    /// </summary>
    private static bool IsIdentifier(string s)
    {
        if (s.Length == 0) return false;
        for (var i = 0; i < s.Length; i += char.IsSurrogatePair(s, i) ? 2 : 1)
        {
            if (char.IsSurrogate(s, i) && !char.IsSurrogatePair(s, i)) return false;
            var category = char.GetUnicodeCategory(s, i);
            var start = category is UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter
                or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
                or UnicodeCategory.LetterNumber || s[i] == '_';
            var part = start || category is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark
                or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.ConnectorPunctuation or UnicodeCategory.Format;
            if (i == 0 ? !start : !part) return false;
        }
        return true;
    }

    /// <summary>The C# keywords: a segment spelt like one is escaped with <c>@</c> where it is emitted.</summary>
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const",
        "continue", "decimal", "default", "delegate", "do", "double", "else", "enum", "event", "explicit", "extern",
        "false", "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in", "int", "interface",
        "internal", "is", "lock", "long", "namespace", "new", "null", "object", "operator", "out", "override",
        "params", "private", "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short",
        "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true", "try", "typeof",
        "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
    };

    // ------------------------------------------------------------------
    // planning
    // ------------------------------------------------------------------

    private static RequirementTestArgs ArgsFor(
        MetaRequirement node, RequirementTestIdentity identity, IReadOnlyList<ResolvedClaim> targets) =>
        new(
            identity,
            node.Attr(RequirementConstants.REQUIREMENT_ATTR_STATEMENT) as string ?? "",
            node.Attr(RequirementConstants.REQUIREMENT_ATTR_COUNTEREXAMPLE) as string ?? "",
            targets.Select(t => new RequirementTestClaim(t.Ref, t.Concern)).ToList(),
            node.Disposition,
            node.TrackedBy);

    /// <summary><c>root</c> for the empty package, otherwise the package with each run of non-ASCII-alphanumerics as one underscore.</summary>
    private static string PackageKey(string package) =>
        package.Length == 0 ? "root" : RequirementTestIdentities.Mangle(package);

    /// <summary>Two tests with one witness key cannot be told apart by a witness: refuse, naming both.</summary>
    private static void RefuseCollisions(List<Planned> planned)
    {
        var pairs = RequirementTestIdentities.WitnessKeyCollisions(planned.Select(p => p.Identity));
        if (pairs.Count == 0) return;
        var keyById = planned.ToDictionary(p => p.Identity.Id, p => p.Identity.WitnessKey, StringComparer.Ordinal);
        var sb = new StringBuilder(ErrWitnessKeyCollision)
            .Append(": two requirement tests map to one witness key, so one witness could not serve both. ")
            .Append("Rename one so the names differ in more than punctuation:");
        foreach (var (first, second) in pairs)
            sb.Append("\n  '").Append(first).Append("' and '").Append(second).Append("' (witness key ").Append(keyById[first]).Append(')');
        throw new InvalidOperationException(sb.ToString());
    }

    private static string UncoveredWarning(IReadOnlyList<string> uncovered)
    {
        var shown = string.Join(", ", uncovered.Take(MaxNamedUncovered));
        var more = uncovered.Count > MaxNamedUncovered
            ? ", and " + (uncovered.Count - MaxNamedUncovered).ToString(CultureInfo.InvariantCulture) + " more"
            : "";
        return uncovered.Count.ToString(CultureInfo.InvariantCulture) + " requirement(s) matched no filter and get no test. " +
               "If that is deliberate, set WarnUncovered = false to silence this. Uncovered: " + shown + more + ".";
    }

    // ------------------------------------------------------------------
    // rendering: the default rendering lives here, in this one file, so an eject takes it too
    // ------------------------------------------------------------------

    private const string GeneratedHeader =
        "// <auto-generated/>\n" +
        "// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n";

    private static string WitnessInterface(DottedName testNamespace, string name, DottedName witnessClass, List<Planned> tests)
    {
        // A real member shows the shape; with none (every test skipped) the pattern stands in for a name.
        var example = tests.FirstOrDefault(t => t.Identity.Skip is null)?.Identity.WitnessKey ?? "req_<address>__<unit>";
        // The interface is named with its namespace: the witness class is in another one by default,
        // so the bare name would not resolve where this line is pasted.
        var sb = new StringBuilder(GeneratedHeader)
            .Append("// Witnesses are project-owned: implement this interface in ").Append(CommentText(witnessClass.Plain))
            .Append(", one EXPLICIT member per witness, e.g.\n")
            .Append("//     void ").Append(testNamespace.Code).Append('.').Append(name).Append('.').Append(example).Append("() { ... }\n")
            .Append("// Explicit, so that a member whose requirement is retired or deleted stops compiling instead of going stale silently.\n")
            .Append("namespace ").Append(testNamespace.Code).Append(";\n\n")
            .Append("public interface ").Append(name).Append("\n{");
        foreach (var p in tests)
        {
            var id = p.Identity;
            if (id.Skip is not null) continue; // a skipped test claims nothing works yet: no member
            sb.Append('\n').Append(Indent(TestComments(p.Args))).Append('\n')
              .Append("    void ").Append(id.WitnessKey).Append("()\n    {\n")
              .Append("        throw new global::Xunit.Sdk.XunitException(\"")
              .Append(StringLiteral(
                  "unimplemented requirement: " + id.Id + " - write " + witnessClass.Plain + "." + id.WitnessKey +
                  "() so that it fails when: " + p.Args.Counterexample))
              .Append("\");\n    }\n");
        }
        return sb.Append("}\n").ToString();
    }

    private static string TestClass(
        DottedName testNamespace, string name, string witnesses, DottedName witnessClass, List<Planned> tests, IRequirementTestRenderer? renderer)
    {
        var usings = new SortedSet<string>(StringComparer.Ordinal) { "Xunit" };
        var body = new StringBuilder();
        foreach (var p in tests)
        {
            var rendered = renderer?.Render(p.Args);
            string source;
            if (rendered is not null)
            {
                foreach (var u in rendered.Usings) usings.Add(u);
                source = rendered.Source;
            }
            else
            {
                source = DefaultTest(p);
            }
            body.Append('\n').Append(Indent(source.TrimEnd())).Append('\n');
        }
        var sb = new StringBuilder(GeneratedHeader)
            .Append("// The witnesses are project-owned, in ").Append(CommentText(witnessClass.Plain)).Append(".\n")
            .Append("// Implement each member explicitly, as the witness interface shows, so that a stale one stops compiling.\n");
        foreach (var u in usings) sb.Append("using ").Append(u).Append(";\n");
        return sb.Append("\nnamespace ").Append(testNamespace.Code).Append(";\n\n")
            .Append("public class ").Append(name).Append("\n{\n")
            .Append("    private readonly ").Append(witnesses).Append(" witnesses = new global::").Append(witnessClass.Code).Append("();\n")
            .Append(body).Append("}\n").ToString();
    }

    /// <summary>The default rendering of one test: its comments, then a <c>[Fact]</c> calling the witness.</summary>
    private static string DefaultTest(Planned p)
    {
        var id = p.Identity;
        var sb = new StringBuilder(TestComments(p.Args)).Append('\n');
        if (id.Skip is null)
        {
            sb.Append("[Fact]\npublic void ").Append(id.WitnessKey).Append("()\n{\n    witnesses.").Append(id.WitnessKey).Append("();\n}");
        }
        else
        {
            sb.Append("[Fact(Skip = \"").Append(StringLiteral(SkipReason(id.Skip))).Append("\")]\n")
              .Append("public void ").Append(id.WitnessKey).Append("()\n{\n}");
        }
        return sb.ToString();
    }

    private static string SkipReason(string skip) => skip switch
    {
        RequirementConstants.REQUIREMENT_STATUS_PLANNED => SkipPlanned,
        RequirementConstants.REQUIREMENT_STATUS_RETIRED => SkipRetired,
        _ => skip + " - skipped",
    };

    /// <summary>The comment block above a test: id, statement, counterexample, status, claims, digest.</summary>
    private static string TestComments(RequirementTestArgs a)
    {
        var id = a.Identity;
        var claims = a.Targets.Count == 0
            ? "(none)"
            : string.Join(", ", a.Targets.Select(c => $"{c.Ref}  ({c.Concern})"));
        return CommentLines(id.Id) + "\n"
            + CommentLines(a.Statement) + "\n"
            + CommentLines("Counterexample: " + a.Counterexample) + "\n"
            + CommentLines("Status: " + (id.Status ?? "(none)")) + "\n"
            + CommentLines("Claims: " + claims) + "\n"
            + CommentLines("Digest: " + id.Digest);
    }

    // ------------------------------------------------------------------
    // escaping: author prose lands in string literals and comments, and must not break either
    // ------------------------------------------------------------------

    private static string Indent(string block)
    {
        var sb = new StringBuilder();
        foreach (var line in block.Split('\n'))
        {
            if (sb.Length > 0) sb.Append('\n');
            if (line.Length > 0) sb.Append("    ").Append(line);
        }
        return sb.ToString();
    }

    // A C# line ends at a line feed, a carriage return, a CR LF pair, or U+0085, U+2028 or U+2029.
    private static readonly Regex LineTerminator = new("\r\n|[\r\n\u0085\u2028\u2029]", RegexOptions.CultureInvariant);

    /// <summary>
    /// One <c>//</c> marker per line: every line terminator of the language splits, so none can end the comment
    /// early and leave the rest of the prose as code. <c>*</c><c>/</c> is broken as <c>* /</c> by contract. C# does
    /// not process a Unicode escape inside a comment, so <c>\u000a</c> stays as written.
    /// </summary>
    private static string CommentLines(string text) =>
        string.Join("\n", LineTerminator.Split(text).Select(line => "// " + CommentText(line)));

    private static string CommentText(string line) => line.Replace("*/", "* /", StringComparison.Ordinal);

    /// <summary>
    /// The text of a regular string literal. Every control character, and the three line terminators beyond
    /// <c>\n</c> and <c>\r</c>, is escaped, so no value can end the literal. A lone surrogate is escaped too: it has
    /// no UTF-8 spelling and would not survive being written to the file.
    /// </summary>
    private static string StringLiteral(string s)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[++i]);
                    }
                    else if (c < 0x20 || c == 0x7f || c == '\u0085' || c == '\u2028' || c == '\u2029' || char.IsSurrogate(c))
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        return sb.ToString();
    }
}
