// Generated output paths keyed by metadata package. With GenConfig.OutputLayout = Package every
// per-object generator writes its file under its object's package, each `::` segment a directory
// (`acme::alpha::Note` -> `acme/alpha/Note.g.cs`); a root-level object stays at the root, and so do
// the context and the run-wide helpers. Two same-named objects in two packages are therefore two
// files. Paths only: the C# namespace is the package binding's, and two same-named types in ONE
// namespace are refused by the claim registry. The default layout, Flat, returns the bare name.

using MetaObjects.Meta;
using static MetaObjects.Shared.Structural;

namespace MetaObjects.Codegen;

/// <summary>Output paths for per-object generated files.</summary>
public static class OutputPaths
{
    /// <summary>
    /// <paramref name="fileName"/> under <paramref name="obj"/>'s metadata package when
    /// <paramref name="config"/> asks for the package layout
    /// (<c>&lt;package segments&gt;/&lt;fileName&gt;</c>); the bare file name otherwise, and at the
    /// root for an object with no package.
    /// </summary>
    public static string Of(MetaData obj, GenConfig config, string fileName)
    {
        if (config.OutputLayout != OutputLayout.Package) return fileName;
        var pkg = PackageBindingResolver.EffectivePackage(obj);
        return string.IsNullOrEmpty(pkg)
            ? fileName
            : string.Join('/', pkg.Split(PACKAGE_SEPARATOR, StringSplitOptions.RemoveEmptyEntries)) + "/" + fileName;
    }

    /// <summary>
    /// <see cref="Of(MetaData, GenConfig, string)"/>, and the path is claimed in the run's registry
    /// for <paramref name="obj"/>, so two objects that would write one file are refused naming both.
    /// </summary>
    public static string Of(MetaData obj, GenContext ctx, string fileName)
    {
        var path = Of(obj, ctx.Config, fileName);
        ctx.Claim("the output directory", path, obj.ResolutionKey(),
            "write the packages apart (csharp.outputLayout \"package\" in .metaobjects/config.json) and map them to distinct " +
            "namespaces (csharp.packageNamespaces, or GenConfig.PackageNamespaces), or rename one");
        return path;
    }
}
