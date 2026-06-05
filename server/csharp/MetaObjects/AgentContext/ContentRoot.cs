// ContentRoot — resolve the agent-context/ content tree the assembler reads.
//
// Two resolution sources (matching the TS/Java/Python references' bundled-then-monorepo
// walk):
//   1. A bundled copy shipped alongside the assembly, at
//      <AppContext.BaseDirectory>/agent-context/ — the .NET tool / CLI csproj copies the
//      repo-root agent-context/ into its output via <Content Include CopyToOutputDirectory>.
//      This is the published path.
//   2. A dev fallback: walk up from AppContext.BaseDirectory (or an explicit anchor) to
//      the monorepo root and use its top-level agent-context/ directory.
//
// A directory is a valid content root iff it holds the authoring skill body.

namespace MetaObjects.AgentContext;

/// <summary>Resolves the <c>agent-context/</c> content tree the assembler reads.</summary>
public static class ContentRoot
{
    /// <summary>A directory is a valid content root iff it holds the authoring skill body.</summary>
    public static bool IsContentRoot(string directory) =>
        File.Exists(Path.Combine(directory, "skills", "metaobjects-authoring", "SKILL.md"));

    /// <summary>
    /// Resolve the content tree: prefer the bundled copy beside the assembly (published
    /// path); fall back to a monorepo <c>agent-context/</c> found by walking up from
    /// <paramref name="anchor"/> (or <see cref="AppContext.BaseDirectory"/> when null).
    /// </summary>
    /// <param name="anchor">A directory to start the monorepo walk-up from; defaults to the assembly base dir.</param>
    /// <returns>The resolved content root.</returns>
    /// <exception cref="DirectoryNotFoundException">If no valid content tree can be found.</exception>
    public static string Resolve(string? anchor = null)
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "agent-context");
        if (IsContentRoot(bundled)) return bundled;

        var dev = WalkUpForMonorepo(anchor ?? AppContext.BaseDirectory);
        if (dev is not null) return dev;

        throw new DirectoryNotFoundException(
            "agent-context content not found — looked for a bundled copy beside the assembly " +
            $"({bundled}) and a monorepo `agent-context/` walking up from " +
            (anchor ?? AppContext.BaseDirectory));
    }

    /// <summary>
    /// Walk up from <paramref name="start"/> to a directory holding a valid
    /// <c>agent-context/</c>, returning its path (or <c>null</c> if none is found).
    /// </summary>
    public static string? WalkUpForMonorepo(string start)
    {
        var dir = new DirectoryInfo(Path.GetFullPath(start));
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "agent-context");
            if (IsContentRoot(candidate)) return candidate;
            dir = dir.Parent;
        }
        return null;
    }
}
