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

    /// <summary>
    /// The index label of a page: its short name, or <c>"&lt;name&gt; (&lt;package&gt;)"</c> when
    /// another unit in the same list shares that name (case-insensitively), so the index tells the
    /// two apart. <paramref name="siblings"/> is the whole list, this unit included. Mirrors the TS
    /// <c>docIndexLabel</c>.
    /// </summary>
    public static string IndexLabel(string name, string? pkg, IEnumerable<string> siblings)
    {
        var shared = siblings.Count(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) > 1;
        return shared && !string.IsNullOrEmpty(pkg) ? $"{name} ({pkg})" : name;
    }

    /// <summary>
    /// Refuse two pages that resolve to the same output path, compared case-insensitively: macOS
    /// and Windows hold <c>ProductNdc.md</c> and <c>ProductNDC.md</c> as one file, so one page
    /// would silently replace the other. Each placement is (path, the node's FQN). Mirrors the TS
    /// <c>assertNoDuplicateDocPaths</c>.
    /// </summary>
    public static void AssertNoDuplicateDocPaths(IEnumerable<(string Path, string Fqn)> placements)
    {
        var seen = new Dictionary<string, (string Path, string Fqn)>(StringComparer.OrdinalIgnoreCase);
        foreach (var placement in placements)
        {
            if (seen.TryGetValue(placement.Path, out var prior))
            {
                throw new InvalidOperationException(prior.Path == placement.Path
                    ? $"docs: duplicate output path \"{placement.Path}\" from nodes {prior.Fqn} and {placement.Fqn} — rename one of them."
                    : $"docs: output paths \"{prior.Path}\" ({prior.Fqn}) and \"{placement.Path}\" ({placement.Fqn}) differ only " +
                      "in case — one file on a case-insensitive filesystem (macOS, Windows), so one page would replace " +
                      "the other. Rename one of them.");
            }
            seen[placement.Path] = placement;
        }
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
