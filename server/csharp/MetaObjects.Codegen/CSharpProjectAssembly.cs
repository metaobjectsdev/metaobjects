// The assembly a generated file is compiled into, read from the project it is written into: the one
// .csproj in the output directory or the nearest directory above it. EF resolves a
// DesignTimeServicesReference with Type.GetType, which needs the assembly name, and generated code
// cannot name its own assembly as a constant.
//
// Limits: the name is the project file's own <AssemblyName> (else its file name); a name
// set in Directory.Build.props, a conditional <AssemblyName>, or an MSBuild expression is not read —
// set GenConfig.ContextAssemblyName then. A found project is cached per directory for the process;
// a miss is not cached, so a project created later in the same process is found.

using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace MetaObjects.Codegen;

/// <summary>Whether EF will read a design-time services reference generated into the context's assembly.</summary>
internal enum DesignTimeReferenceNeed
{
    /// <summary>The context's migrations are in its own project: the generated reference is read.</summary>
    Unnecessary,
    /// <summary>The migrations are in another project, which already carries the reference.</summary>
    Present,
    /// <summary>The migrations are in another project, which does not carry it.</summary>
    Needed,
    /// <summary>No migrations were found, so nothing proves the generated reference is read.</summary>
    Unknown,
}

internal static class CSharpProjectAssembly
{
    private static readonly ConcurrentDictionary<string, string?> Projects = new(StringComparer.Ordinal);

    /// <summary>
    /// The project's <c>&lt;AssemblyName&gt;</c>, else its file name, or <c>null</c> when no directory
    /// from <paramref name="outDir"/> up holds exactly one <c>.csproj</c>, or the name is an MSBuild
    /// expression. A directory with several projects is ambiguous and stops the search.
    /// </summary>
    public static string? Find(string outDir) => FindProject(outDir) is { } project ? AssemblyName(project) : null;

    /// <summary>The one <c>.csproj</c> in <paramref name="dir"/> or the nearest directory above it, or null.</summary>
    public static string? FindProject(string dir)
    {
        string full;
        try { full = Path.GetFullPath(dir); }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
        if (Projects.TryGetValue(full, out var cached)) return cached;
        var found = Search(full);
        if (found is not null) Projects[full] = found;
        return found;

        static string? Search(string start)
        {
            for (var d = new DirectoryInfo(start); d is not null; d = d.Parent)
            {
                string[] projects;
                try { projects = d.Exists ? Directory.GetFiles(d.FullName, "*.csproj") : []; }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
                if (projects.Length > 1) return null;
                if (projects.Length == 1) return projects[0];
            }
            return null;
        }
    }

    /// <summary>
    /// Whether EF will read the <c>[assembly: DesignTimeServicesReference]</c>
    /// generated into the context's project. EF reads that attribute only from the startup and the
    /// migrations assemblies, so it is read when the context's project holds the migrations. Those are
    /// found by the model snapshot EF writes beside them (<c>&lt;Context&gt;ModelSnapshot.cs</c>), searched
    /// from the repository (the nearest directory above the project holding <c>.git</c>, else the
    /// farthest holding a <c>.sln</c>); another project holding them must carry the reference itself, in
    /// any of its <c>.cs</c> files but the migrations. Returns the migrations project when one was found.
    /// <para>It errs toward warning, because a false all-clear is a silent
    /// RESTART. Every snapshot is examined (a stale copy in the context's project does not hide a real
    /// migrations project elsewhere); a snapshot counts only when it names THIS context (its
    /// <c>typeof</c> qualified with, or a <c>using</c> / <c>namespace</c> of, the context's namespace),
    /// so a same-named context of another module cannot clear it; and the line counts only in code
    /// (not in a comment or an <c>#if</c> block), naming the services type and, when known,
    /// <paramref name="contextAssembly"/>.</para>
    /// </summary>
    public static (DesignTimeReferenceNeed Need, string? MigrationsProject) DesignTimeReference(
        string outDir, string contextClassName, string servicesTypeName, string? contextAssembly = null)
    {
        if (FindProject(outDir) is not { } project) return (DesignTimeReferenceNeed.Unknown, null);
        var dot = servicesTypeName.LastIndexOf('.');
        var contextNamespace = dot > 0 ? servicesTypeName[..dot] : "";
        var snapshots = FindFiles(RepositoryRoot(Path.GetDirectoryName(project)!), contextClassName + "ModelSnapshot.cs");
        string? lacking = null;
        string? present = null;
        string? inContextProject = null;
        foreach (var snapshot in snapshots)
        {
            if (!SnapshotNamesContext(snapshot, contextNamespace, contextClassName)) continue;
            if (FindProject(Path.GetDirectoryName(snapshot)!) is not { } migrations) continue;
            if (string.Equals(migrations, project, StringComparison.Ordinal)) inContextProject ??= migrations;
            else if (CarriesReference(Path.GetDirectoryName(migrations)!, servicesTypeName, contextAssembly)) present ??= migrations;
            else lacking ??= migrations;
        }
        if (lacking is not null) return (DesignTimeReferenceNeed.Needed, lacking);
        if (inContextProject is not null) return (DesignTimeReferenceNeed.Unnecessary, inContextProject);
        return present is not null ? (DesignTimeReferenceNeed.Present, present) : (DesignTimeReferenceNeed.Unknown, null);
    }

    /// <summary>True when the snapshot's <c>[DbContext(typeof(...))]</c> names the context in
    /// <paramref name="contextNamespace"/>: qualified, or bare under a <c>using</c> or <c>namespace</c> of it.</summary>
    private static bool SnapshotNamesContext(string snapshot, string contextNamespace, string contextClassName)
    {
        string text;
        try { text = StripCommentsAndConditionals(File.ReadAllText(snapshot)); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return false; }
        var ns = Regex.Escape(contextNamespace);
        var cls = Regex.Escape(contextClassName);
        if (Regex.IsMatch(text, $@"typeof\(\s*(global::)?{ns}\.{cls}\s*\)")) return true;
        return Regex.IsMatch(text, $@"typeof\(\s*{cls}\s*\)")
            && Regex.IsMatch(text, $@"(?m)^\s*(using\s+(global::)?{ns}\s*;|namespace\s+{ns}\s*[;{{])");
    }

    /// <summary>C# source with its comments and its <c>#if</c> … <c>#endif</c> blocks removed, so only
    /// code that always compiles is read. (A string literal holding a comment marker loses its tail,
    /// which can only turn a match into a miss, that is, into a warning.)</summary>
    private static string StripCommentsAndConditionals(string text)
    {
        text = Regex.Replace(text, @"/\*.*?\*/", " ", RegexOptions.Singleline);
        text = Regex.Replace(text, @"//[^\n]*", "");
        return Regex.Replace(text, @"(?ms)^\s*#if\b.*?^\s*#endif\b[^\n]*", "");
    }

    private static readonly HashSet<string> SkippedDirectories = new(StringComparer.OrdinalIgnoreCase) { "bin", "obj", "node_modules", ".git", ".vs", ".idea" };

    private static string RepositoryRoot(string projectDir)
    {
        string? solution = null;
        for (var d = new DirectoryInfo(projectDir); d is not null; d = d.Parent)
        {
            try
            {
                if (Directory.Exists(Path.Combine(d.FullName, ".git")) || File.Exists(Path.Combine(d.FullName, ".git"))) return d.FullName;
                if (Directory.GetFiles(d.FullName, "*.sln").Length > 0) solution = d.FullName;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { break; }
        }
        return solution ?? projectDir;
    }

    private static List<string> FindFiles(string root, string fileName)
    {
        var found = new List<string>();
        var pending = new Stack<string>([root]);
        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            try
            {
                found.AddRange(Directory.GetFiles(dir, fileName));
                foreach (var sub in Directory.GetDirectories(dir))
                    if (!SkippedDirectories.Contains(Path.GetFileName(sub))) pending.Push(sub);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        }
        found.Sort(StringComparer.Ordinal);
        return found;
    }

    /// <summary>
    /// True when a <c>.cs</c> file of the project in <paramref name="projectDir"/> carries a
    /// <c>DesignTimeServicesReference</c> naming <paramref name="servicesTypeName"/>. A migration
    /// (<c>&lt;14 digits&gt;_&lt;name&gt;.cs</c>) and a model snapshot are skipped: neither holds it, and a
    /// large project has thousands.
    /// </summary>
    private static bool CarriesReference(string projectDir, string servicesTypeName, string? contextAssembly)
    {
        var svc = Regex.Escape(servicesTypeName);
        var asm = contextAssembly is { Length: > 0 } ? Regex.Escape(contextAssembly) : "[^\"]+";
        var attribute = new Regex(
            @"\[\s*assembly\s*:\s*(global::)?(Microsoft\.EntityFrameworkCore\.Design\.)?DesignTimeServicesReference(Attribute)?\s*\(\s*""\s*"
            + svc + @"\s*,\s*" + asm + @"\s*""");
        foreach (var file in FindFiles(projectDir, "*.cs"))
        {
            var name = Path.GetFileName(file);
            if (name.EndsWith("ModelSnapshot.cs", StringComparison.Ordinal)) continue;
            if (name.Length > 15 && name[..14].All(char.IsAsciiDigit) && name[14] == '_') continue;
            string text;
            try { text = File.ReadAllText(file); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { continue; }
            if (!text.Contains("DesignTimeServicesReference", StringComparison.Ordinal)) continue;
            if (attribute.IsMatch(StripCommentsAndConditionals(text))) return true;
        }
        return false;
    }

    private static string? AssemblyName(string csproj)
    {
        string? declared;
        try
        {
            declared = XDocument.Load(csproj).Descendants()
                .LastOrDefault(e => e.Name.LocalName == "AssemblyName" && e.Parent?.Name.LocalName == "PropertyGroup")?.Value.Trim();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
        var name = string.IsNullOrEmpty(declared) ? Path.GetFileNameWithoutExtension(csproj) : declared;
        return name.Contains("$(", StringComparison.Ordinal) ? null : name;
    }
}

/// <summary>
/// The engine's answer to "will EF read the design-time services reference
/// generated into the context's assembly?". EF reads <c>[assembly: DesignTimeServicesReference]</c>
/// only from the startup and migrations assemblies, so the generated one is read when the context's
/// project holds the migrations; elsewhere the migrations project carries the line itself.
/// </summary>
public static class DesignTimeServicesReferences
{
    /// <summary>
    /// The warning for a context whose generated reference cannot be shown to be read, naming
    /// <paramref name="line"/> (the exact attribute to add); null when the context's project holds
    /// its migrations, or the migrations project already references <paramref name="servicesTypeName"/>.
    /// The migrations are found by <c>&lt;contextName&gt;ModelSnapshot.cs</c> in the repository of
    /// <see cref="GenConfig.OutDir"/>'s project.
    /// </summary>
    public static string? Warning(GenConfig config, string generator, string contextName, string servicesTypeName, string line, string consequence)
    {
        var assembly = config.ContextAssemblyName;
        var (need, migrations) = CSharpProjectAssembly.DesignTimeReference(config.OutDir, contextName, servicesTypeName, assembly);
        return need switch
        {
            DesignTimeReferenceNeed.Needed =>
                $"{generator}: the migrations of {contextName} are in {migrations}, not in the context's project ({assembly}), " +
                $"and that project does not reference {servicesTypeName}. EF reads [assembly: DesignTimeServicesReference] only " +
                $"from the startup and migrations assemblies, so it never reads the one generated beside the context; {consequence}. " +
                $"Add this line to a .cs file of that project: {line}",
            DesignTimeReferenceNeed.Unknown =>
                $"{generator}: cannot tell whether EF reads the DesignTimeServicesReference generated beside {contextName}: EF reads it " +
                $"only from the startup and migrations assemblies, and no {contextName}ModelSnapshot.cs was found to show that " +
                $"{assembly} holds the migrations. If the migrations are in another project, add this line to it ({consequence}): {line}",
            _ => null,
        };
    }
}
