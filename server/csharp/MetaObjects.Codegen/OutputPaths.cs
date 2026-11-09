// Generated output paths keyed by metadata package (R39). Every per-object generator writes its
// file under its object's package, each `::` segment a directory (`acme::alpha::Note` →
// `acme/alpha/Note.g.cs`); a root-level object stays at the root. Two same-named objects in two
// packages are therefore two files. Paths only: the C# namespace is the package binding's
// (GenConfig.PackageNamespaces), unchanged here — two same-named types in ONE namespace are still
// refused by the claim registry (ruling R52).

using MetaObjects.Meta;
using static MetaObjects.Shared.Structural;

namespace MetaObjects.Codegen;

public static class OutputPaths
{
    /// <summary>
    /// <paramref name="fileName"/> under <paramref name="obj"/>'s metadata package:
    /// <c>&lt;package segments&gt;/&lt;fileName&gt;</c>, or the bare file name at the root.
    /// </summary>
    public static string Of(MetaData obj, string fileName)
    {
        var pkg = PackageBindingResolver.EffectivePackage(obj);
        return string.IsNullOrEmpty(pkg)
            ? fileName
            : string.Join('/', pkg.Split(PACKAGE_SEPARATOR, StringSplitOptions.RemoveEmptyEntries)) + "/" + fileName;
    }
}
