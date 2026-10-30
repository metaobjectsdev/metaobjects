// The C# namespace `dotnet meta gen` and `dotnet meta verify --codegen` generate under. It comes
// from the command line, the project's config and its metadata — never from reading generated or
// user source — so gen and verify resolve the same value by construction.

using MetaObjects.Library;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

public static class CodegenNamespace
{
    /// <summary>
    /// <c>--namespace</c> when given, else <c>csharp.namespace</c> from <c>.metaobjects/config.json</c>,
    /// else the project's metadata package with each <c>::</c> segment PascalCased
    /// (<c>acme::shop</c> becomes <c>Acme.Shop</c>), as the Java port turns a package into a Java package.
    /// The project's package is the one its own objects share (the longest common <c>::</c> prefix);
    /// objects from a library or a metadata dependency are not the project's.
    /// </summary>
    /// <exception cref="ArgumentException">Nothing is given and the project's objects share no package, or the
    /// package has a segment that is not a C# identifier once PascalCased (<c>my-app</c>, <c>2fa</c>).</exception>
    public static string Resolve(string? flag, string? configured, MetaRoot root)
    {
        if (!string.IsNullOrWhiteSpace(flag)) return flag;
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        var package = ProjectPackage(root);
        if (package.Count == 0)
            throw new ArgumentException(
                "cannot derive the C# namespace: the project's metadata objects share no package. " + SetOne);
        var segments = package.Select(CSharpNaming.Pascal).ToList();
        if (segments.FirstOrDefault(s => !Identifier.IsMatch(s)) is { } bad)
            throw new ArgumentException(
                $"cannot derive the C# namespace: \"{bad}\" (from the metadata package \"{string.Join("::", package)}\") " +
                "is not a C# identifier. " + SetOne);
        return string.Join(".", segments);
    }

    private const string SetOne =
        "Set \"csharp\": { \"namespace\": \"<ns>\" } in .metaobjects/config.json or pass --namespace <ns>.";

    private static readonly System.Text.RegularExpressions.Regex Identifier = new("^[A-Za-z_][A-Za-z0-9_]*$");

    private static IReadOnlyList<string> ProjectPackage(MetaRoot root)
    {
        var libraries = LibrarySources.LibraryPackages();
        List<string>? common = null;
        foreach (var obj in root.Objects())
        {
            var package = PackageBindingResolver.EffectivePackage(obj) ?? "";
            if (libraries.Contains(package) || !root.InScope(obj)) continue;
            var segments = package.Split(PackageBindingResolver.MetaPackageSeparator, StringSplitOptions.RemoveEmptyEntries);
            if (common is null)
            {
                common = [.. segments];
                continue;
            }
            var shared = 0;
            while (shared < common.Count && shared < segments.Length && common[shared] == segments[shared]) shared++;
            common.RemoveRange(shared, common.Count - shared);
        }
        return common ?? [];
    }
}
