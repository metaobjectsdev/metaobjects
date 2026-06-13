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
        "    verify <metadataDir> [--templates <root>] [--codegen --out <dir> [--namespace <ns>]] [--db]\n" +
        "                                                     drift gates (ADR-0021 D2 subverbs):\n" +
        "                                                       --templates  template/prompt drift (default)\n" +
        "                                                       --codegen    regen-to-temp vs committed --out\n" +
        "                                                       --namespace  codegen regen namespace; inferred\n" +
        "                                                                    from the committed --out when omitted\n" +
        "                                                       --db         NOT supported in C# (migrate engine)\n" +
        "    docs <metadataDir> --out <dir> [--project <name>] [--model-base-url <url>]\n" +
        "                                                     emit the generated C# SDK api reference\n" +
        "                                                     (the api/csharp surface: one page per\n" +
        "                                                     entity + template, README, AGENT-API)\n" +
        "    agent-docs [--server <lang>]... [--client <fw>]... [--out <dir>]\n" +
        "                                                     scaffold the slim MetaObjects Claude Code\n" +
        "                                                     agent context (defaults to csharp when a\n" +
        "                                                     *.csproj is present)");
    return 2;
}

return args[0] switch
{
    "gen" => RunGen(args[1..]),
    "verify" => RunVerify(args[1..]),
    "docs" => RunDocs(args[1..]),
    "agent-docs" => AgentDocsCommand.Run(args[1..]),
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

    // Advisory: nudge a re-scaffold if the copied-in agent context predates this build.
    // Never throws, never changes the exit code (a missing/corrupt manifest is ignored).
    AgentContextStalenessCheck.WarnIfStale(Directory.GetCurrentDirectory());

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

// `dotnet meta docs` — emit the generated C# SDK api reference (the `api/csharp`
// surface). Parses <metadataDir> --out <dir> [--project <name>] [--model-base-url <url>],
// builds + renders the api-docs IR via DocsCommand (pure logic), and writes the pages.
static int RunDocs(string[] rest)
{
    string? metadataDir = null;
    string? outDir = null;
    string? project = null;
    string? modelBaseUrl = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (rest[i] == "--project" && i + 1 < rest.Length) project = rest[++i];
        else if (rest[i] == "--model-base-url" && i + 1 < rest.Length) modelBaseUrl = rest[++i];
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
    }

    if (metadataDir is null || outDir is null)
    {
        Console.Error.WriteLine("usage: dotnet meta docs <metadataDir> --out <dir> [--project <name>] [--model-base-url <url>]");
        return 2;
    }

    // Default the project label to the input directory's leaf name (cosmetic — surfaces
    // in the AGENT-API header). Trailing-separator-safe.
    project ??= new DirectoryInfo(Path.TrimEndingDirectorySeparator(Path.GetFullPath(metadataDir))).Name;

    var outcome = DocsCommand.Run(metadataDir, outDir, project, modelBaseUrl: modelBaseUrl);
    if (!outcome.Ok)
    {
        foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
        Console.Error.WriteLine("dotnet meta docs: FAILED (metadata did not load cleanly)");
        return 1;
    }
    foreach (var p in outcome.WrittenPaths) Console.WriteLine($"  written: {p}");
    Console.WriteLine($"dotnet meta docs: {outcome.WrittenPaths.Count} api page(s) written");
    return 0;
}

static int Unknown(string cmd)
{
    Console.Error.WriteLine($"dotnet meta: unknown command \"{cmd}\"");
    return 2;
}

// `dotnet meta verify` — ADR-0021 D2 explicit subverbs. Parses --templates /
// --codegen / --db, dispatches each requested gate via VerifyCommand.RunSubverbs
// (pure logic), and aggregates the exit code (max; non-zero on any drift). A bare
// `verify` keeps the historical default = templates + prints a one-line note.
static int RunVerify(string[] rest)
{
    string? metadataDir = null;
    string? templatesRoot = null;
    string? outDir = null;
    string ns = "Generated";
    bool nsExplicit = false;
    string? generatorsCsv = null;
    string? templateRoot = null;
    bool templates = false, codegen = false, db = false;

    for (int i = 0; i < rest.Length; i++)
    {
        var a = rest[i];
        if (a == "--templates")
        {
            templates = true;
            // --templates may take an inline root, or fall back to a default below.
            if (i + 1 < rest.Length && !rest[i + 1].StartsWith('-')) templatesRoot = rest[++i];
        }
        else if (a == "--codegen") codegen = true;
        else if (a == "--db") db = true;
        else if (a == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (a == "--namespace" && i + 1 < rest.Length) { ns = rest[++i]; nsExplicit = true; }
        else if (a == "--generators" && i + 1 < rest.Length) generatorsCsv = rest[++i];
        else if (a == "--template-root" && i + 1 < rest.Length) templateRoot = rest[++i];
        else if (a.StartsWith('-'))
        {
            Console.Error.WriteLine($"dotnet meta verify: unknown option \"{a}\"");
            Console.Error.WriteLine("usage: dotnet meta verify <metadataDir> [--templates <root>] [--codegen --out <dir> [--namespace <ns>]] [--db]");
            return 2;
        }
        else if (metadataDir is null) metadataDir = a;
        // A second positional is the templates root for a BARE verify
        // (`verify <metadataDir> <templatesRoot>`) — keeps the historical default
        // reachable without an explicit subverb (so the subverb note prints).
        else templatesRoot ??= a;
    }

    if (metadataDir is null)
    {
        Console.Error.WriteLine("usage: dotnet meta verify <metadataDir> [--templates <root>] [--codegen --out <dir> [--namespace <ns>]] [--db]");
        return 2;
    }

    // The templates gate needs a root. Bare verify (defaults to templates) and an
    // explicit --templates both require it; surface a clear usage error if absent.
    var wantsTemplates = templates || (!codegen && !db);
    if (wantsTemplates && templatesRoot is null)
    {
        Console.Error.WriteLine("usage: dotnet meta verify <metadataDir> --templates <templatesRoot>");
        Console.Error.WriteLine("  (the templates gate is the default; pass --codegen --out <dir> for codegen drift —");
        Console.Error.WriteLine("   --namespace is inferred from the committed output when omitted)");
        return 2;
    }

    // Advisory: nudge a re-scaffold if the copied-in agent context predates this build.
    // Never throws, never changes the exit code (a missing/corrupt manifest is ignored).
    AgentContextStalenessCheck.WarnIfStale(Directory.GetCurrentDirectory());

    var generators = generatorsCsv
        ?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    var opts = new VerifyCommand.Options
    {
        MetadataDir = metadataDir,
        TemplatesRoot = templatesRoot,
        OutDir = outDir,
        Namespace = ns,
        NamespaceExplicit = nsExplicit,
        Generators = generators,
        TemplateRoot = templateRoot,
        Templates = templates,
        Codegen = codegen,
        Db = db,
    };

    var result = VerifyCommand.RunSubverbs(opts);

    if (result.EmittedDefaultNote) Console.WriteLine(VerifyCommand.SUBVERB_NOTE);

    // -- templates gate output --
    if (result.RanTemplates && result.Templates is { } t)
    {
        foreach (var e in t.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
        foreach (var u in t.UnresolvedText) Console.Error.WriteLine($"  {u}");
        foreach (var d in t.Errors) Console.Error.WriteLine($"  drift {d.Template}: {d.Code} ({d.Path})");
        foreach (var w in t.Warnings) Console.WriteLine($"  warning {w.Template}: {w.Code} ({w.Path})");
        Console.WriteLine(t.Ok ? "dotnet meta verify --templates: OK" : "dotnet meta verify --templates: FAILED");
    }

    // -- codegen gate output --
    if (result.RanCodegen && result.Codegen is { } c)
    {
        if (c.Error is not null)
        {
            Console.Error.WriteLine($"  {c.Error}");
        }
        else if (c.Clean)
        {
            Console.WriteLine("dotnet meta verify --codegen: OK (generated output is in sync)");
        }
        else
        {
            Console.Error.WriteLine($"dotnet meta verify --codegen: drift ({c.DriftedFiles.Count} file(s) differ from a fresh regen):");
            foreach (var line in c.Lines) Console.Error.WriteLine($"  {line}");
            Console.Error.WriteLine("Run 'dotnet meta gen' to regenerate, then commit the result.");
        }
    }

    // -- db gate (rejected in C#) --
    if (result.DbRejectionMessage is not null)
        Console.Error.WriteLine($"  {result.DbRejectionMessage}");

    return result.ExitCode;
}
