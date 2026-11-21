// The layout ratchet's analyzer (ADR-0063): finds layout a generator typed by hand.
//
// Generators say what a line contains and the writer decides where it sits, so generator source
// should never spell a line break or an indentation run. This reads a source file with Roslyn's
// parser and walks the syntax tree. Working on the tree, not the text, is what makes the rules
// exact: a comment is never a node, so never a finding; a string's value is the parser's cooked
// value, so "\n", "\u000a" and a verbatim literal that spans lines are the same finding; and a
// constant is followed to its declaration, so `const string NL = "\n"; Join(NL, xs)` is a finding
// at the join as well as at the declaration.
//
// Six rules:
//
//   newline-literal      a string, interpolated-string text or char literal whose value holds a line break.
//   indent-literal       a string that starts a line of output (a whole string, or the head of an
//                        interpolated one) and begins with an indentation run: two or more spaces, or a tab.
//   newline-join         string.Join(sep, ...) whose separator holds a line break, resolved through
//                        same-file constants.
//   indent-repeat        new string(' ', n), Enumerable.Repeat(" ", n) or "".PadLeft(n): building indentation.
//   append-line          StringBuilder.AppendLine: the line break is typed by the platform, not the writer.
//   environment-newline  Environment.NewLine, for the same reason (and it differs between platforms).
//
// Three places a literal is not output, and so is not layout, are ruled out by position:
//
//   - a search pattern: the first argument of Split, IndexOf, LastIndexOf, IndexOfAny, Contains,
//     StartsWith, EndsWith, Replace, Trim, TrimStart or TrimEnd, and anything given to Regex;
//   - a writer snippet: the argument of a `.Text(...)` call, the writer's entry for fixed code
//     written as it should read (it removes the margin and re-indents).
//   - an attribute argument and a `nameof`.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace MetaObjects.Codegen.Tests.LayoutRatchet;

public enum FindingKind
{
    NewlineLiteral,
    IndentLiteral,
    NewlineJoin,
    IndentRepeat,
    AppendLine,
    EnvironmentNewline,
}

public sealed record Finding(FindingKind Kind, int Line, int Column, string Excerpt);

internal static class LayoutAnalyzer
{
    private static readonly HashSet<string> SearchMethods = new(StringComparer.Ordinal)
    {
        "Split", "IndexOf", "LastIndexOf", "IndexOfAny", "Contains", "StartsWith", "EndsWith",
        "Replace", "Trim", "TrimStart", "TrimEnd",
    };

    private const string SnippetMethod = "Text";
    private const int MaxResolveDepth = 8;

    /// <summary>What a string expression is known to contain. <c>Complete</c> is false when part of it is unknown.</summary>
    private readonly record struct Resolved(string Text, bool Complete);

    internal static IReadOnlyList<Finding> Analyze(string source)
    {
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest));
        var root = tree.GetRoot();
        var consts = CollectConsts(root);
        var findings = new List<Finding>();

        void Report(FindingKind kind, SyntaxNode node)
        {
            var pos = tree.GetLineSpan(node.Span).StartLinePosition;
            var raw = string.Join(' ', node.ToString().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            findings.Add(new Finding(kind, pos.Line + 1, pos.Character + 1, raw.Length > 60 ? raw[..57] + "..." : raw));
        }

        Resolved? Resolve(ExpressionSyntax? expr, int depth = 0)
        {
            if (expr is null || depth > MaxResolveDepth) return null;
            switch (expr)
            {
                case LiteralExpressionSyntax lit when lit.IsKind(SyntaxKind.StringLiteralExpression) || lit.IsKind(SyntaxKind.CharacterLiteralExpression):
                    return new Resolved(lit.Token.ValueText, true);
                case ParenthesizedExpressionSyntax p:
                    return Resolve(p.Expression, depth + 1);
                case BinaryExpressionSyntax b when b.IsKind(SyntaxKind.AddExpression):
                {
                    var l = Resolve(b.Left, depth + 1);
                    var r = Resolve(b.Right, depth + 1);
                    if (l is null && r is null) return null;
                    return new Resolved((l?.Text ?? "") + (r?.Text ?? ""), l?.Complete == true && r?.Complete == true);
                }
                case InterpolatedStringExpressionSyntax interp:
                {
                    var text = "";
                    var complete = true;
                    foreach (var part in interp.Contents)
                    {
                        if (part is InterpolatedStringTextSyntax t) text += t.TextToken.ValueText;
                        else if (part is InterpolationSyntax i)
                        {
                            var sub = Resolve(i.Expression, depth + 1);
                            text += sub?.Text ?? "";
                            complete &= sub?.Complete == true;
                        }
                    }
                    return new Resolved(text, complete);
                }
                case ConditionalExpressionSyntax c:
                {
                    var a = Resolve(c.WhenTrue, depth + 1);
                    var b = Resolve(c.WhenFalse, depth + 1);
                    if (a is null && b is null) return null;
                    // Either branch may be written; for "does it contain a line break" both count.
                    return new Resolved((a?.Text ?? "") + (b?.Text ?? ""), false);
                }
                case IdentifierNameSyntax id:
                    return consts.TryGetValue(id.Identifier.ValueText, out var init) ? Resolve(init, depth + 1) : null;
                case MemberAccessExpressionSyntax m when IsEnvironmentNewline(m):
                    return new Resolved("\n", true);
                default:
                    return null;
            }
        }

        void CheckLiteral(SyntaxNode literal, string value, bool startsALine, SyntaxNode whole)
        {
            if (IsSearchPattern(whole) || IsSnippet(whole) || InAttributeOrNameof(whole)) return;
            if (value.IndexOfAny(['\r', '\n']) >= 0) Report(FindingKind.NewlineLiteral, literal);
            else if (startsALine && StartsWithIndentRun(value)) Report(FindingKind.IndentLiteral, literal);
        }

        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                case LiteralExpressionSyntax lit when lit.IsKind(SyntaxKind.StringLiteralExpression):
                    CheckLiteral(lit, lit.Token.ValueText, true, lit);
                    break;
                case LiteralExpressionSyntax ch when ch.IsKind(SyntaxKind.CharacterLiteralExpression):
                    if (ch.Token.ValueText is "\n" or "\r" && !IsSearchPattern(ch) && !InAttributeOrNameof(ch)) Report(FindingKind.NewlineLiteral, ch);
                    break;
                case InterpolatedStringExpressionSyntax interp:
                {
                    var first = true;
                    foreach (var part in interp.Contents)
                    {
                        if (part is InterpolatedStringTextSyntax t) CheckLiteral(t, t.TextToken.ValueText, first, interp);
                        first = false;
                    }
                    break;
                }
                case InvocationExpressionSyntax call:
                    CheckCall(call);
                    break;
                case MemberAccessExpressionSyntax m when IsEnvironmentNewline(m):
                    Report(FindingKind.EnvironmentNewline, m);
                    break;
                case ObjectCreationExpressionSyntax created when IsStringCtor(created) && created.ArgumentList is { Arguments.Count: 2 } args:
                {
                    var unit = Resolve(args.Arguments[0].Expression);
                    if (unit is { Complete: true } u && IsWhitespace(u.Text)) Report(FindingKind.IndentRepeat, created);
                    break;
                }
            }
        }

        return findings;

        void CheckCall(InvocationExpressionSyntax call)
        {
            var method = CalledName(call);
            var args = call.ArgumentList.Arguments;
            switch (method)
            {
                case "AppendLine":
                    Report(FindingKind.AppendLine, call);
                    break;
                case "Join" when IsStringJoin(call) && args.Count > 0:
                {
                    var sep = Resolve(args[0].Expression);
                    if (sep is { } s && s.Text.IndexOfAny(['\r', '\n']) >= 0) Report(FindingKind.NewlineJoin, call);
                    break;
                }
                case "Repeat" when call.Expression is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "Enumerable" } } && args.Count == 2:
                {
                    var unit = Resolve(args[0].Expression);
                    if (unit is { Complete: true } u && IsWhitespace(u.Text)) Report(FindingKind.IndentRepeat, call);
                    break;
                }
                case "PadLeft" or "PadRight" when call.Expression is MemberAccessExpressionSyntax pad:
                {
                    var unit = Resolve(pad.Expression);
                    if (unit is { Complete: true } u && (u.Text.Length == 0 || IsWhitespace(u.Text))) Report(FindingKind.IndentRepeat, call);
                    break;
                }
            }
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────

    private static bool StartsWithIndentRun(string value) =>
        value.StartsWith("  ", StringComparison.Ordinal) || value.StartsWith('\t');

    private static bool IsWhitespace(string value) => value.Length > 0 && value.All(c => c is ' ' or '\t' or '\r' or '\n');

    private static bool IsEnvironmentNewline(MemberAccessExpressionSyntax m) =>
        m.Name.Identifier.ValueText == "NewLine"
        && m.Expression is IdentifierNameSyntax { Identifier.ValueText: "Environment" }
            or MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Environment" };

    private static bool IsStringCtor(ObjectCreationExpressionSyntax created) =>
        created.Type is PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.StringKeyword }
        or IdentifierNameSyntax { Identifier.ValueText: "String" };

    private static bool IsStringJoin(InvocationExpressionSyntax call) =>
        call.Expression is MemberAccessExpressionSyntax
        {
            Expression: PredefinedTypeSyntax { Keyword.RawKind: (int)SyntaxKind.StringKeyword }
                or IdentifierNameSyntax { Identifier.ValueText: "String" }
        };

    /// <summary>The method name a call invokes: <c>x.Join(...)</c> is "Join", <c>Join(...)</c> is "Join".</summary>
    private static string? CalledName(InvocationExpressionSyntax call) => call.Expression switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.ValueText,
        IdentifierNameSyntax i => i.Identifier.ValueText,
        _ => null,
    };

    /// <summary>The argument slot a node fills, when it is directly an argument of a call.</summary>
    private static (InvocationExpressionSyntax Call, int Index)? ArgumentOf(SyntaxNode expr)
    {
        if (expr.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: InvocationExpressionSyntax call } list } arg)
            return (call, list.Arguments.IndexOf(arg));
        return null;
    }

    private static bool IsSearchPattern(SyntaxNode expr)
    {
        if (expr.Parent is ArgumentSyntax { Parent: ArgumentListSyntax { Parent: ObjectCreationExpressionSyntax created } }
            && created.Type.ToString() is "Regex" or "System.Text.RegularExpressions.Regex")
            return true;
        if (ArgumentOf(expr) is not { } slot) return false;
        if (slot.Call.Expression is MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "Regex" } }) return true;
        var name = CalledName(slot.Call);
        return name is not null && slot.Index == 0 && SearchMethods.Contains(name);
    }

    private static bool IsSnippet(SyntaxNode expr) =>
        ArgumentOf(expr) is { Index: 0 } slot && CalledName(slot.Call) == SnippetMethod;

    private static bool InAttributeOrNameof(SyntaxNode node) =>
        node.AncestorsAndSelf().Any(n => n is AttributeSyntax)
        || (ArgumentOf(node) is { } slot && CalledName(slot.Call) == "nameof");

    /// <summary>Every <c>const string name = expr</c> in the file. A name declared more than once is left out: it is shadowed somewhere.</summary>
    private static Dictionary<string, ExpressionSyntax> CollectConsts(SyntaxNode root)
    {
        var seen = new Dictionary<string, ExpressionSyntax?>(StringComparer.Ordinal);
        void Note(string name, ExpressionSyntax? init) => seen[name] = seen.ContainsKey(name) ? null : init;

        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                case FieldDeclarationSyntax f:
                    foreach (var v in f.Declaration.Variables)
                        Note(v.Identifier.ValueText, f.Modifiers.Any(SyntaxKind.ConstKeyword) || IsStaticReadonly(f) ? v.Initializer?.Value : null);
                    break;
                case LocalDeclarationStatementSyntax l:
                    foreach (var v in l.Declaration.Variables)
                        Note(v.Identifier.ValueText, l.IsConst ? v.Initializer?.Value : null);
                    break;
                case ParameterSyntax p:
                    Note(p.Identifier.ValueText, null);
                    break;
            }
        }
        return seen.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Key, kv => kv.Value!, StringComparer.Ordinal);
    }

    private static bool IsStaticReadonly(FieldDeclarationSyntax f) =>
        f.Modifiers.Any(SyntaxKind.StaticKeyword) && f.Modifiers.Any(SyntaxKind.ReadOnlyKeyword);

    // ── which files the ratchet reads ────────────────────────────────────────────────────

    /// <summary>The project whose source is generator source, relative to <c>server/csharp/</c>.</summary>
    internal const string ScannedProject = "MetaObjects.Codegen";

    /// <summary>
    /// Whether a file (relative to <c>server/csharp/</c>) is generator source the ratchet reads.
    /// Excluded by rule, never by listing: anything outside the codegen project, build output, the
    /// writer itself (the one module family that lays text out), the helper runtime that generated
    /// code calls (it is shipped source, not a generator), and the documentation emitters
    /// (<c>Docs/</c>, <c>ApiDocs/</c>: markdown is not generated code).
    /// </summary>
    internal static bool IsGeneratorSource(string rel)
    {
        var path = rel.Replace('\\', '/');
        if (!path.StartsWith(ScannedProject + "/", StringComparison.Ordinal) || !path.EndsWith(".cs", StringComparison.Ordinal)) return false;
        var inside = path[(ScannedProject.Length + 1)..];
        if (inside.StartsWith("bin/") || inside.StartsWith("obj/")) return false;
        foreach (var dir in new[] { "Writer/", "Runtime/", "Docs/", "ApiDocs/" })
            if (inside.StartsWith(dir, StringComparison.Ordinal)) return false;
        return true;
    }
}
