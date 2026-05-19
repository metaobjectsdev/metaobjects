// CorpusRoot — resolves the single fixtures/conformance/ corpus directory.
//
// Honors the METAOBJECTS_CONFORMANCE_CORPUS env var (mirrors the TS runner's
// override for mutation-testing sandboxes). Otherwise walks up from
// AppContext.BaseDirectory until a directory containing fixtures/conformance/ is found.

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Resolves the <c>fixtures/conformance/</c> corpus root once at startup.
/// </summary>
public static class CorpusRoot
{
    /// <summary>Absolute path to the corpus root directory.</summary>
    public static string Path { get; } = Resolve();

    private static string Resolve()
    {
        // Environment override — lets mutation-testing sandboxes point at the
        // real corpus via an absolute path.
        var env = Environment.GetEnvironmentVariable("METAOBJECTS_CONFORMANCE_CORPUS");
        if (!string.IsNullOrEmpty(env))
        {
            if (!Directory.Exists(env))
                throw new DirectoryNotFoundException(
                    $"METAOBJECTS_CONFORMANCE_CORPUS points to a non-existent directory: {env}");
            return env;
        }

        // Walk up from the test binary's base directory until we find a directory
        // that contains fixtures/conformance/.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = System.IO.Path.Combine(dir.FullName, "fixtures", "conformance");
            if (Directory.Exists(candidate))
                return candidate;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate fixtures/conformance/ by walking up from " +
            AppContext.BaseDirectory +
            ". Set METAOBJECTS_CONFORMANCE_CORPUS to point directly to the corpus.");
    }
}
