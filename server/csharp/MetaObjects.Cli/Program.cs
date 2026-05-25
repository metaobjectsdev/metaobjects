// `meta` — the MetaObjects C# CLI host. Subcommands hang off here; `verify` is
// the first (the FR-004 build-time prompt drift gate). `gen` / `migrate` follow.

using MetaObjects.Cli;

if (args.Length == 0)
{
    Console.Error.WriteLine(
        "usage: meta <command> [options]\n" +
        "  commands:\n" +
        "    gen <metadataDir> --out <dir> --namespace <ns>   generate EF Core code from metadata\n" +
        "    migrate <metadataDir> --out <file.sql> [--from-db <conn> --down <file.sql>]\n" +
        "                                                     emit Postgres DDL — full CREATE by default, or\n" +
        "                                                     an incremental migration when --from-db is given\n" +
        "    verify <metadataDir> --templates <root>          drift-check templates against their payloads");
    return 2;
}

return args[0] switch
{
    "gen" => RunGen(args[1..]),
    "migrate" => RunMigrate(args[1..]),
    "verify" => RunVerify(args[1..]),
    _ => Unknown(args[0]),
};

static int RunMigrate(string[] rest)
{
    string? metadataDir = null;
    string? outFile = null;
    string? fromDb = null;
    string? downFile = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--out" && i + 1 < rest.Length) outFile = rest[++i];
        else if (rest[i] == "--from-db" && i + 1 < rest.Length) fromDb = rest[++i];
        else if (rest[i] == "--down" && i + 1 < rest.Length) downFile = rest[++i];
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
    }
    if (metadataDir is null || outFile is null)
    {
        Console.Error.WriteLine("usage: meta migrate <metadataDir> --out <file.sql> [--from-db <conn> --down <file.sql>]");
        return 2;
    }

    if (fromDb is not null) return RunIncrementalMigrate(metadataDir, outFile, fromDb, downFile).GetAwaiter().GetResult();

    var outcome = MigrateCommand.Run(metadataDir, outFile);
    if (!outcome.Ok)
    {
        foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
        Console.Error.WriteLine("meta migrate: FAILED (metadata did not load cleanly)");
        return 1;
    }
    foreach (var w in outcome.Warnings) Console.Error.WriteLine($"  warning: {w}");
    Console.WriteLine($"meta migrate: wrote {outFile}");
    return 0;
}

static async Task<int> RunIncrementalMigrate(string metadataDir, string upFile, string connString, string? downFile)
{
    await using var db = await NpgsqlIntrospector.ConnectAsync(connString);
    var outcome = await MigrateCommand.RunIncrementalAsync(metadataDir, db, upFile, downFile);

    foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
    foreach (var b in outcome.Blocked) Console.Error.WriteLine($"  BLOCKED: {b}");
    if (outcome.LoadErrors.Count > 0)
    {
        Console.Error.WriteLine("meta migrate: FAILED (metadata did not load cleanly)");
        return 1;
    }
    if (outcome.Blocked.Count > 0)
    {
        Console.Error.WriteLine("meta migrate: BLOCKED — re-run with appropriate allow flags");
        return 1;
    }
    Console.WriteLine($"meta migrate: wrote {upFile}{(downFile is null ? "" : $" (+ down: {downFile})")}");
    return 0;
}

static int RunGen(string[] rest)
{
    string? metadataDir = null;
    string? outDir = null;
    string ns = "Generated";
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (rest[i] == "--namespace" && i + 1 < rest.Length) ns = rest[++i];
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
    }
    if (metadataDir is null || outDir is null)
    {
        Console.Error.WriteLine("usage: meta gen <metadataDir> --out <dir> [--namespace <ns>]");
        return 2;
    }

    var outcome = GenCommand.Run(metadataDir, outDir, ns);
    if (!outcome.Ok)
    {
        foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
        Console.Error.WriteLine("meta gen: FAILED (metadata did not load cleanly)");
        return 1;
    }
    foreach (var f in outcome.Result!.Files) Console.WriteLine($"  {f.Status}: {f.Path}");
    foreach (var w in outcome.Result!.Warnings) Console.Error.WriteLine($"  warning: {w}");
    Console.WriteLine($"meta gen: {outcome.Result!.Files.Count(f => f.Status == "written")} file(s) written");
    return 0;
}

static int Unknown(string cmd)
{
    Console.Error.WriteLine($"meta: unknown command \"{cmd}\"");
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
        Console.Error.WriteLine("usage: meta verify <metadataDir> --templates <templatesRoot>");
        return 2;
    }

    var outcome = VerifyCommand.Run(metadataDir, templatesRoot);
    foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
    foreach (var u in outcome.UnresolvedText) Console.Error.WriteLine($"  {u}");
    foreach (var d in outcome.Errors) Console.Error.WriteLine($"  drift {d.Template}: {d.Code} ({d.Path})");
    foreach (var w in outcome.Warnings) Console.WriteLine($"  warning {w.Template}: {w.Code} ({w.Path})");

    if (outcome.Ok)
    {
        Console.WriteLine("meta verify: OK");
        return 0;
    }
    Console.Error.WriteLine("meta verify: FAILED");
    return 1;
}
