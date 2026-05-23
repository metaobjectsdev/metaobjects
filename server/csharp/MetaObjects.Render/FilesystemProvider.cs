// Filesystem-backed provider: resolves a `group/source` reference to
// <root>/<group>/<source>.mustache. The render engine + verify delegate all I/O
// to a provider, so this is the only file-touching piece of the render tier.
//
// Mirrors the FilesystemProvider contract noted in
// typescript/packages/render/src/provider.ts.

namespace MetaObjects.Render;

/// <summary>
/// Resolves <c>group/source</c> references to text files under a root directory:
/// <c>resolve("npc/turn")</c> → <c>&lt;root&gt;/npc/turn.mustache</c>. Returns null
/// when the file is absent. Refs that escape the root (via <c>..</c>) are rejected.
/// </summary>
public sealed class FilesystemProvider : IProvider
{
    private readonly string _root;
    private readonly string _extension;

    public FilesystemProvider(string root, string extension = ".mustache")
    {
        _root = Path.GetFullPath(root);
        _extension = extension;
    }

    public string? Resolve(string reference)
    {
        // Build <root>/<seg>/<seg>.<ext> from the slash-separated ref.
        var segments = reference.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return null;

        var combined = Path.GetFullPath(Path.Combine([_root, .. segments])) + _extension;

        // Path-traversal guard: the resolved file must stay under the root.
        if (!combined.StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.Ordinal) &&
            !combined.StartsWith(_root, StringComparison.Ordinal))
            return null;

        return File.Exists(combined) ? File.ReadAllText(combined) : null;
    }
}
