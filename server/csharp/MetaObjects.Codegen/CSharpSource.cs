// Reads of C# source go through Roslyn's syntax tree, never a regex or substring over the text:
// a comment or string literal that merely mentions `namespace X` or `Generators.All` is trivia or
// a literal token there, not a declaration or a member access.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace MetaObjects.Codegen;

public static class CSharpSource
{
    /// <summary>The name of the first top-level namespace (file-scoped or block) declared in
    /// <paramref name="source"/>, or <c>null</c> when it declares none.</summary>
    public static string? TopLevelNamespace(string source)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        return root.Members.OfType<BaseNamespaceDeclarationSyntax>()
            .Select(n => n.Name.ToString().Replace(" ", ""))
            .FirstOrDefault();
    }

    /// <summary>True iff <paramref name="source"/> evaluates the member <paramref name="member"/> of a type
    /// named <paramref name="typeName"/> (<c>Generators.All</c>, <c>My.Ns.Generators.All</c>), or names
    /// <c>member</c> bare under a <c>using static</c> of that type. Comments and string literals never count.</summary>
    public static bool ReferencesMember(string source, string typeName, string member)
    {
        var root = CSharpSyntaxTree.ParseText(source).GetCompilationUnitRoot();
        var nodes = root.DescendantNodes().ToList();

        if (nodes.OfType<MemberAccessExpressionSyntax>().Any(m =>
                m.Name.Identifier.ValueText == member && LastName(m.Expression) == typeName))
            return true;

        var staticallyImported = nodes.OfType<UsingDirectiveSyntax>().Any(u =>
            u.StaticKeyword.IsKind(SyntaxKind.StaticKeyword)
            && u.NamespaceOrType is { } t && LastName(t) == typeName);
        return staticallyImported && nodes.OfType<IdentifierNameSyntax>().Any(i =>
            i.Identifier.ValueText == member
            && !(i.Parent is MemberAccessExpressionSyntax m && m.Name == i));
    }

    /// <summary>The rightmost simple name of <c>A</c>, <c>A.B</c> or <c>global::A.B</c>; null for anything else.</summary>
    private static string? LastName(SyntaxNode node) => node switch
    {
        IdentifierNameSyntax id => id.Identifier.ValueText,
        QualifiedNameSyntax q => LastName(q.Right),
        AliasQualifiedNameSyntax a => LastName(a.Name),
        MemberAccessExpressionSyntax m => LastName(m.Name),
        _ => null,
    };
}
