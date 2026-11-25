// Since 1.3.0 the helper runtime the packaged routes call is the MetaObjects.AspNetCore package, not
// part of MetaObjects.Codegen (see HelperRuntime). An app that compiled its generated routes against
// MetaObjects.Codegen alone stops compiling after the regen that moves their `using` line, so
// `dotnet meta gen` and `dotnet meta verify` warn when a generated file imports
// MetaObjects.AspNetCore and the project that compiles it does not reference the package.
//
// The project is the one .csproj in the file's directory or the nearest directory above it (the
// rule CSharpProjectAssembly applies to the DbContext's assembly). The reference counts when that
// project, a project it references (transitively), or a Directory.Build.props/.targets above any of
// them names MetaObjects.AspNetCore in a PackageReference or a ProjectReference. It errs toward
// silence: no project found, or one that cannot be read, gives no warning.
//
// It also warns on generated output that still imports the helpers from MetaObjects.Codegen.Runtime
// (the output of a routes generator owned from before 1.3.0), which no longer compiles. Advisory
// only: nothing here reaches an exit code.

using System.Text.RegularExpressions;

namespace MetaObjects.Codegen;

public static class HelperRuntimeReference
{
    private static readonly string ImportLine = "using " + HelperRuntime.PackagedNamespace + ";";

    private static readonly Regex Reference = new(
        @"<\s*(PackageReference|ProjectReference)\b[^>]*\b(Include|Update)\s*=\s*""([^""]*[\\/])?"
        + Regex.Escape(HelperRuntime.PackageId) + @"(\.csproj)?\s*""",
        RegexOptions.IgnoreCase);

    private static readonly Regex ProjectReferencePath = new(
        @"<\s*ProjectReference\b[^>]*\bInclude\s*=\s*""([^""]+\.csproj)""", RegexOptions.IgnoreCase);

    private static readonly string FormerImportLine = "using " + HelperRuntime.FormerNamespace + ";";

    // A helper type named as a whole word: what makes a former import a broken one (ExtractObject and
    // M2MResolver are still in MetaObjects.Codegen.Runtime, so the import alone proves nothing).
    private static readonly Regex HelperTypeUse = new(
        @"\b(" + string.Join("|", HelperRuntime.Files.Select(f => Regex.Escape(Path.GetFileNameWithoutExtension(f)))) + @")\b");

    /// <summary>True when generated <paramref name="content"/> imports the packaged helper runtime.</summary>
    public static bool Imports(string content) => content.Contains(ImportLine, StringComparison.Ordinal);

    /// <summary>True when generated <paramref name="content"/> still imports the helpers from
    /// <see cref="HelperRuntime.FormerNamespace"/>, where they are no longer (1.3.0): output of a
    /// routes generator owned before then, which does not compile against MetaObjects.Codegen 1.3.0.</summary>
    public static bool ImportsFormer(string content) =>
        content.Contains(FormerImportLine, StringComparison.Ordinal) && HelperTypeUse.IsMatch(content);

    /// <summary>The warning for generated files (<paramref name="shown"/> names) that import the helpers
    /// from their pre-1.3.0 namespace; null when there are none.</summary>
    public static string? FormerImportWarning(IReadOnlyList<string> shown)
    {
        if (shown.Count == 0) return null;
        var sorted = shown.OrderBy(s => s, StringComparer.Ordinal).ToList();
        var example = sorted.Count > 1 ? $"{sorted[0]} and {sorted.Count - 1} other generated file(s) import" : $"{sorted[0]} imports";
        return $"{example} {HelperRuntime.FormerNamespace} for the route helpers (FilterParser, EfCoreFilterDispatch, ...), which " +
            $"since 1.3.0 are in the {HelperRuntime.PackageId} package, namespace {HelperRuntime.PackagedNamespace}, so it will not compile. " +
            $"Reference the {HelperRuntime.PackageId} package and run `dotnet meta gen`; the packaged generators write the " +
            $"new import. If the generator that wrote it is a copy you own from before 1.3.0, also set its " +
            $"HelperRuntimeNamespace constant to \"{HelperRuntime.PackagedNamespace}\", or run " +
            $"`dotnet meta eject routes --force` to own the current generators and the helpers with them.";
    }

    /// <summary>
    /// One warning per project that compiles a file of <paramref name="files"/> importing
    /// <see cref="HelperRuntime.PackagedNamespace"/> without referencing <see cref="HelperRuntime.PackageId"/>.
    /// <paramref name="files"/> are absolute paths with their content; <paramref name="shown"/> turns a
    /// path into the name the warning reports.
    /// </summary>
    public static IReadOnlyList<string> Warnings(IEnumerable<(string Path, string Content)> files, Func<string, string>? shown = null)
    {
        var list = files.ToList();
        var warnings = WarningsForImporting(list.Where(f => Imports(f.Content)).Select(f => (f.Path, shown?.Invoke(f.Path) ?? f.Path))).ToList();
        if (FormerImportWarning(list.Where(f => ImportsFormer(f.Content)).Select(f => shown?.Invoke(f.Path) ?? f.Path).ToList()) is { } former)
            warnings.Add(former);
        return warnings;
    }

    /// <summary><see cref="Warnings"/> for files already known to import the helper runtime, each
    /// with the name the warning reports it by.</summary>
    public static IReadOnlyList<string> WarningsForImporting(IEnumerable<(string Path, string Shown)> importing)
    {
        var byProject = new SortedDictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var (path, shownAs) in importing)
        {
            if (CSharpProjectAssembly.FindProject(Path.GetDirectoryName(path)!) is not { } project) continue;
            if (!byProject.TryGetValue(project, out var list)) byProject[project] = list = [];
            list.Add(shownAs);
        }
        var warnings = new List<string>();
        foreach (var (project, imported) in byProject)
        {
            if (References(project) is not false) continue;
            imported.Sort(StringComparer.Ordinal);
            var example = imported.Count > 1 ? $"{imported[0]} and {imported.Count - 1} other generated file(s) import" : $"{imported[0]} imports";
            warnings.Add(
                $"{example} {HelperRuntime.PackagedNamespace}, but {project} does not reference the " +
                $"{HelperRuntime.PackageId} package, so it will not compile. Since 1.3.0 the helpers generated routes " +
                $"call (FilterParser, EfCoreFilterDispatch, ValueObjectValidator, ConstraintErrors, ...) are that package, " +
                $"no longer part of MetaObjects.Codegen. Add to {Path.GetFileName(project)}: " +
                $"<PackageReference Include=\"{HelperRuntime.PackageId}\" Version=\"{ToolVersion()}\" />");
        }
        return warnings;
    }

    /// <summary>
    /// <see cref="Warnings"/> for the generated files already on disk under <paramref name="dirs"/>:
    /// what <c>verify</c> reads, since the committed tree is what the app compiles. Only files that
    /// carry <see cref="CodegenRunner.GeneratedMarker"/> are read past their first bytes.
    /// </summary>
    public static IReadOnlyList<string> ForTrees(IEnumerable<string> dirs, string? relativeTo = null)
    {
        var files = new List<(string, string)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var dir in dirs.Select(Path.GetFullPath).Distinct(StringComparer.Ordinal))
        {
            if (!Directory.Exists(dir)) continue;
            IEnumerable<string> found;
            try { found = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories).ToList(); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
            foreach (var file in found)
            {
                if (!seen.Add(file) || IsUnderBuildOutput(dir, file)) continue;
                string text;
                try { text = File.ReadAllText(file); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
                if (text.Contains(CodegenRunner.GeneratedMarker, StringComparison.Ordinal)) files.Add((file, text));
            }
        }
        return Warnings(files, relativeTo is null ? null : p => Path.GetRelativePath(relativeTo, p).Replace('\\', '/'));
    }

    /// <summary><see cref="ForTrees"/> over every directory the run of <paramref name="generators"/> writes
    /// into, reported relative to <paramref name="projectRoot"/>.</summary>
    public static IReadOnlyList<string> ForRun(GenConfig config, IEnumerable<IGenerator> generators, string? projectRoot) =>
        ForTrees(generators.Select(CodegenRunner.OutRootFor(config)).Append(config.OutDir), projectRoot);

    private static bool IsUnderBuildOutput(string root, string file)
    {
        var rel = Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return rel.Take(rel.Length - 1).Any(s => s is "bin" or "obj");
    }

    /// <summary>
    /// Whether <paramref name="project"/> references the package: directly, through a project it
    /// references, or through a Directory.Build.props/.targets above one of them. Null when a file on
    /// the way cannot be read, so the caller stays silent rather than guess.
    /// </summary>
    internal static bool? References(string project)
    {
        var pending = new Queue<string>([Path.GetFullPath(project)]);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var unreadable = false;
        while (pending.Count > 0)
        {
            var csproj = pending.Dequeue();
            if (!visited.Add(csproj)) continue;
            if (!File.Exists(csproj)) continue;
            string text;
            try { text = File.ReadAllText(csproj); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { unreadable = true; continue; }
            if (Reference.IsMatch(text)) return true;
            foreach (var props in BuildFilesAbove(Path.GetDirectoryName(csproj)!))
            {
                if (!visited.Add(props)) continue;
                try { if (Reference.IsMatch(File.ReadAllText(props))) return true; }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { unreadable = true; }
            }
            foreach (Match m in ProjectReferencePath.Matches(text))
                pending.Enqueue(Path.GetFullPath(Path.Combine(Path.GetDirectoryName(csproj)!,
                    m.Groups[1].Value.Replace('\\', Path.DirectorySeparatorChar))));
        }
        return unreadable ? null : false;
    }

    private static IEnumerable<string> BuildFilesAbove(string dir)
    {
        for (var d = new DirectoryInfo(dir); d is not null; d = d.Parent)
            foreach (var name in new[] { "Directory.Build.props", "Directory.Build.targets" })
            {
                var path = Path.Combine(d.FullName, name);
                if (File.Exists(path)) yield return path;
            }
    }

    private static string ToolVersion()
    {
        var v = typeof(HelperRuntimeReference).Assembly.GetName().Version;
        return v is null ? "*" : $"{v.Major}.{v.Minor}.{v.Build}";
    }
}
