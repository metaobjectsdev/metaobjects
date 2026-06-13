// Doc-page path math for the C# native SDK-docs surface (api/csharp).
//
// Byte-parity with the Java DocsPaths (server/java/.../apidocs/DocsPaths.java) and
// the TS docs-paths.ts contract: the same layout + relative-href math, so the
// shared fixtures/conformance/api-docs-cross-port/expected-paths.json resolves
// identically across all ports. Nothing here is C#-specific — it is pure path math.

namespace MetaObjects.Codegen.ApiDocs;

/// <summary>
/// Doc-page path math: package/flat layout + relative cross-href computation,
/// mirroring the Java/TS contract so the cross-port layout manifest resolves
/// identically. The api-docs renderer + the <c>docs</c> command call these; they
/// never re-derive a path.
/// </summary>
public static class DocsPaths
{
    /// <summary>Doc-page layout: one file per unit (<see cref="Flat"/>) or foldered by package (<see cref="Package"/>).</summary>
    public enum Layout
    {
        /// <summary>One file per unit at the surface root (<c>&lt;name&gt;.md</c>).</summary>
        Flat,
        /// <summary>Foldered by package (<c>&lt;pkg-folded&gt;/&lt;name&gt;.md</c>).</summary>
        Package,
    }

    /// <summary><c>"acme::shop"</c> or <c>"acme.shop"</c> → <c>"acme/shop"</c>; null/"" → "".</summary>
    public static string PackageToPath(string? pkg)
    {
        if (string.IsNullOrEmpty(pkg)) return "";
        return pkg.Replace("::", "/").Replace(".", "/");
    }

    /// <summary>Flat → <c>"&lt;name&gt;.md"</c>; Package → <c>"&lt;pkg-folded&gt;/&lt;name&gt;.md"</c>.</summary>
    public static string DocPageOutputPath(Layout layout, string? pkg, string name)
    {
        var file = name + ".md";
        if (layout == Layout.Flat) return file;
        var dir = PackageToPath(pkg);
        return dir.Length == 0 ? file : dir + "/" + file;
    }

    /// <summary>Relative posix href from <paramref name="fromOutputPath"/>'s directory to
    /// <paramref name="toOutputPath"/> (mirrors the TS <c>surfaceCrossHref</c>).</summary>
    public static string SurfaceCrossHref(string fromOutputPath, string toOutputPath)
    {
        var slash = fromOutputPath.LastIndexOf('/');
        var fromDir = slash >= 0 ? fromOutputPath[..slash] : "";
        var rel = PosixRelative(fromDir, toOutputPath);
        return rel.StartsWith('.') ? rel : "./" + rel;
    }

    /// <summary>
    /// From an api page to its model page: relative by default, absolute when
    /// <paramref name="modelBaseUrl"/> is set (federated docs).
    /// </summary>
    public static string ModelCrossHref(string apiPagePath, string modelPagePath, string? modelBaseUrl)
    {
        if (!string.IsNullOrEmpty(modelBaseUrl))
            return modelBaseUrl.TrimEnd('/') + "/" + modelPagePath;
        return SurfaceCrossHref(apiPagePath, modelPagePath);
    }

    // node:path/posix relative(fromDir, toPath): drop the common prefix, ".." per
    // remaining fromDir segment, then the remaining toPath segments. "" fromDir →
    // toPath; identical → ".".
    private static string PosixRelative(string fromDir, string toPath)
    {
        if (fromDir.Length == 0) return toPath;
        var from = fromDir.Split('/');
        var to = toPath.Split('/');
        int common = 0, max = Math.Min(from.Length, to.Length);
        while (common < max && from[common] == to[common]) common++;
        var rel = new System.Text.StringBuilder();
        for (var i = common; i < from.Length; i++) { if (rel.Length > 0) rel.Append('/'); rel.Append(".."); }
        for (var i = common; i < to.Length; i++) { if (rel.Length > 0) rel.Append('/'); rel.Append(to[i]); }
        return rel.Length == 0 ? "." : rel.ToString();
    }
}
