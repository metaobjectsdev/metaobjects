// The assembly a generated file is compiled into, read from the project it is written into: the one
// .csproj in the output directory or the nearest directory above it. EF resolves a
// DesignTimeServicesReference with Type.GetType, which needs the assembly name, and generated code
// cannot name its own assembly as a constant.

using System.Xml.Linq;

namespace MetaObjects.Codegen;

internal static class CSharpProjectAssembly
{
    /// <summary>
    /// The project's <c>&lt;AssemblyName&gt;</c>, else its file name, or <c>null</c> when no directory
    /// from <paramref name="outDir"/> up holds exactly one <c>.csproj</c>, or the name is an MSBuild
    /// expression. A directory with several projects is ambiguous and stops the search.
    /// </summary>
    public static string? Find(string outDir)
    {
        DirectoryInfo? dir;
        try { dir = new DirectoryInfo(Path.GetFullPath(outDir)); }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException) { return null; }
        for (; dir is not null; dir = dir.Parent)
        {
            string[] projects;
            try { projects = dir.Exists ? Directory.GetFiles(dir.FullName, "*.csproj") : []; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
            if (projects.Length > 1) return null;
            if (projects.Length == 1) return AssemblyName(projects[0]);
        }
        return null;
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
