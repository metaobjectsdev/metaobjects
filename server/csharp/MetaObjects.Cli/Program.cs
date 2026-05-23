// `meta` — the MetaObjects C# CLI host. Subcommands hang off here; `verify` is
// the first (the FR-004 build-time prompt drift gate). `gen` / `migrate` follow.

using MetaObjects.Cli;

if (args.Length == 0)
{
    Console.Error.WriteLine(
        "usage: meta <command> [options]\n" +
        "  commands:\n" +
        "    verify <metadataDir> --templates <root>   drift-check templates against their payloads");
    return 2;
}

return args[0] switch
{
    "verify" => RunVerify(args[1..]),
    _ => Unknown(args[0]),
};

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
