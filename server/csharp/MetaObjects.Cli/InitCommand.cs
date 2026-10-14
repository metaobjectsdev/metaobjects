// `dotnet meta init` — ADR-0034 Amendment 9. Writes the codegen project that holds the
// project's generator list: codegen/Generators.cs (the list), codegen/Program.cs (a two-line
// entry point that runs it) and codegen/Codegen.csproj. `dotnet meta gen` and `dotnet meta
// verify --codegen` run that project, and refuse in a project without the list.
//
// Each file is written only when it is missing. Once it exists it is the project's own
// configuration, exactly like metaobjects.config.ts on the TypeScript side: init and eject
// never edit it again. `dotnet meta eject` writes the same three files when they are missing,
// with the generators it ejected already in the list.

namespace MetaObjects.Cli;

/// <summary>The three files of the codegen project, as init and eject write them.</summary>
public static class CodegenScaffold
{
    /// <summary>The project-relative paths of the three files, in the order they are reported.</summary>
    public static readonly IReadOnlyList<string> Files = ["codegen/Generators.cs", "codegen/Program.cs", "codegen/Codegen.csproj"];

    private const string CsprojTemplate =
        """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <OutputType>Exe</OutputType>
            <TargetFramework>net8.0</TargetFramework>
            <ImplicitUsings>enable</ImplicitUsings>
            <Nullable>enable</Nullable>
          </PropertyGroup>
          <ItemGroup>
            <PackageReference Include="MetaObjects.Codegen" Version="{VERSION}" />
          </ItemGroup>
          <!-- runtime/ is the helper runtime your GENERATED code compiles with (your app
               project includes it); it is not part of this codegen tool. -->
          <ItemGroup>
            <Compile Remove="runtime/**" />
          </ItemGroup>
        </Project>

        """;

    /// <summary>codegen/Codegen.csproj, pinning <c>MetaObjects.Codegen</c> to the tool's own version.</summary>
    public static string Csproj() => CsprojTemplate.Replace("{VERSION}", EjectCommand.ToolVersion());

    /// <summary>codegen/Program.cs: the two-line entry point that runs the list.</summary>
    public const string ProgramCs =
        "// Runs the generator list in Generators.cs. `dotnet meta gen` and `dotnet meta verify --codegen`\n" +
        "// run this project (`dotnet run --project codegen -- <args>`); see MetaObjects.Codegen.CodegenCli.Run.\n" +
        "using MetaObjects.Codegen;\n" +
        "return CodegenCli.Run(args, Generators.All);\n";

    /// <summary>
    /// codegen/Generators.cs, the project's generator list, holding <paramref name="entries"/>:
    /// each a C# expression that constructs a generator, such as
    /// <c>new Codegen.Generators.EntityGenerator()</c>.
    /// </summary>
    public static string GeneratorsCs(IEnumerable<string> entries)
    {
        var lines = string.Concat(entries.Select(e => $"        {e},\n"));
        return
            "// The generator list (ADR-0034 Amendment 9). `dotnet meta gen` runs exactly these entries and\n" +
            "// `dotnet meta verify --codegen` regenerates them and compares; nothing else is generated,\n" +
            "// documentation included. Each entry is a generator with its options as init properties.\n" +
            "// `dotnet meta gen --list` is the catalog. `dotnet meta eject <name>` copies a generator into\n" +
            "// codegen/generators/ to own; list the copy (Codegen.Generators.<Name>) in place of the\n" +
            "// packaged one. `dotnet meta gen --generators <names>` narrows a run to the entries named.\n" +
            "//\n" +
            "// For example:\n" +
            "//   new MetaObjects.Codegen.Generators.EntityGenerator(),\n" +
            "//   new MetaObjects.Codegen.Generators.DbContextGenerator(),\n" +
            "//   new MetaObjects.Codegen.Generators.ApiDocsGenerator { OutDir = \"docs/generated\", ProjectName = \"shop\" },\n" +
            "using MetaObjects.Codegen;\n" +
            "\n" +
            "public static class Generators\n" +
            "{\n" +
            "    public static IReadOnlyList<IGenerator> All { get; } =\n" +
            "    [\n" +
            lines +
            "    ];\n" +
            "}\n";
    }

    /// <summary>
    /// Write each of the three files under <paramref name="root"/> that is missing, the list with
    /// <paramref name="entries"/>. Returns the project-relative paths written; an existing file is
    /// never touched.
    /// </summary>
    public static IReadOnlyList<string> WriteMissing(string root, IEnumerable<string> entries)
    {
        var written = new List<string>();
        foreach (var rel in Files)
        {
            var path = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(path)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, rel switch
            {
                "codegen/Generators.cs" => GeneratorsCs(entries),
                "codegen/Program.cs" => ProgramCs,
                _ => Csproj(),
            });
            written.Add(rel);
        }
        return written;
    }
}

/// <summary>The init command's pure logic: write what is missing and report it.</summary>
public static class InitCommand
{
    public static IReadOnlyList<string> Run(string root)
    {
        var written = CodegenScaffold.WriteMissing(root, []);
        var lines = new List<string>();
        foreach (var rel in CodegenScaffold.Files)
            lines.Add(written.Contains(rel) ? $"  wrote {rel}" : $"  kept {rel} (already yours)");
        lines.Add("");
        lines.Add(
            "codegen/Generators.cs is the generator list `dotnet meta gen` runs. It declares nothing yet, " +
            "so gen writes nothing until you add entries: `dotnet meta gen --list` is the catalog.");
        return lines;
    }
}
