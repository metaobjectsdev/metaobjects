// `dotnet meta` — the MetaObjects C# CLI host, packaged as a .NET tool (command
// `dotnet-meta`, invoked `dotnet meta`). Subcommands hang off here: `gen` (EF Core
// codegen) and `verify` (the FR-004 build-time prompt drift gate). It is NOT a bare
// `meta` executable — that name belongs to the canonical Node `meta` CLI.
//
// Schema migrations are owned by the TypeScript `meta` CLI (ADR-0015): the C# CLI
// keeps codegen + verify only. There is no `migrate` / `--from-db` surface here.

using MetaObjects.Cli;

if (args.Length == 0)
{
    Console.Error.WriteLine(
        "usage: dotnet meta <command> [options]\n" +
        "  commands:\n" +
        "    gen <metadataDir> --out <dir> --namespace <ns> [--emit-abstract-shapes]\n" +
        "        [--generators <a,b,c>] [--template-root <dir>]\n" +
        "                                                     generate EF Core code from metadata\n" +
        "    gen --list                                       list available generators (stable names) and exit\n" +
        "    verify <metadataDir> --templates <root>          drift-check templates against their payloads");
    return 2;
}

return args[0] switch
{
    "gen" => RunGen(args[1..]),
    "verify" => RunVerify(args[1..]),
    _ => Unknown(args[0]),
};

static int RunGen(string[] rest)
{
    string? metadataDir = null;
    string? outDir = null;
    string ns = "Generated";
    bool emitAbstractShapes = false;
    bool list = false;
    string? generatorsCsv = null;
    string? templateRoot = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--list") list = true;
        else if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (rest[i] == "--namespace" && i + 1 < rest.Length) ns = rest[++i];
        else if (rest[i] == "--generators" && i + 1 < rest.Length) generatorsCsv = rest[++i];
        else if (rest[i] == "--template-root" && i + 1 < rest.Length) templateRoot = rest[++i];
        else if (rest[i] == "--emit-abstract-shapes") emitAbstractShapes = true;
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
    }

    // `--list` — discoverability surface (ADR-0021 D3). Print and exit 0, no codegen.
    if (list)
    {
        Console.WriteLine("available generators (select with --generators <name,...>):");
        foreach (var line in GenCommand.ListLines()) Console.WriteLine(line);
        return 0;
    }

    if (metadataDir is null || outDir is null)
    {
        Console.Error.WriteLine("usage: dotnet meta gen <metadataDir> --out <dir> [--namespace <ns>] [--generators <a,b,c>] [--template-root <dir>] [--emit-abstract-shapes]");
        Console.Error.WriteLine("       dotnet meta gen --list");
        return 2;
    }

    var generatorNames = generatorsCsv
        ?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    var outcome = GenCommand.Run(metadataDir, outDir, ns, emitAbstractShapes, generatorNames, templateRoot);
    if (!outcome.Ok)
    {
        foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
        Console.Error.WriteLine("dotnet meta gen: FAILED (metadata did not load cleanly)");
        return 1;
    }
    foreach (var f in outcome.Result!.Files) Console.WriteLine($"  {f.Status}: {f.Path}");
    foreach (var w in outcome.Result!.Warnings) Console.Error.WriteLine($"  warning: {w}");
    Console.WriteLine($"dotnet meta gen: {outcome.Result!.Files.Count(f => f.Status == "written")} file(s) written");
    return 0;
}

static int Unknown(string cmd)
{
    Console.Error.WriteLine($"dotnet meta: unknown command \"{cmd}\"");
    return 2;
}

static int RunVerify(string[] rest)
{
    string? metadataDir = null;
    string? templatesRoot = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--templates" && i + 1 < rest.Length) templatesRoot = rest[++i];
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
    }
    if (metadataDir is null || templatesRoot is null)
    {
        Console.Error.WriteLine("usage: dotnet meta verify <metadataDir> --templates <templatesRoot>");
        return 2;
    }

    var outcome = VerifyCommand.Run(metadataDir, templatesRoot);
    foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
    foreach (var u in outcome.UnresolvedText) Console.Error.WriteLine($"  {u}");
    foreach (var d in outcome.Errors) Console.Error.WriteLine($"  drift {d.Template}: {d.Code} ({d.Path})");
    foreach (var w in outcome.Warnings) Console.WriteLine($"  warning {w.Template}: {w.Code} ({w.Path})");

    if (outcome.Ok)
    {
        Console.WriteLine("dotnet meta verify: OK");
        return 0;
    }
    Console.Error.WriteLine("dotnet meta verify: FAILED");
    return 1;
}
