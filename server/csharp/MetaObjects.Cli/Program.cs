// `dotnet meta` — the MetaObjects C# CLI host, packaged as a .NET tool (command
// `dotnet-meta`, invoked `dotnet meta`). Subcommands hang off here: `gen` (EF Core
// codegen) and `verify` (the FR-004 build-time prompt drift gate). It is NOT a bare
// `meta` executable — that name belongs to the canonical Node `meta` CLI.
//
// Schema migrations are owned by the TypeScript `meta` CLI (ADR-0015): the C# CLI
// keeps codegen + verify only. There is no `migrate` / `--from-db` surface here.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Config;

// `--version`, `-v` and `-V` print the bare version and exit 0 — the same three spellings
// every port's CLI answers. Checked before anything else so a version probe never parses
// a command.
if (args.Length == 1 && args[0] is "--version" or "-v" or "-V")
{
    Console.WriteLine(EjectCommand.ToolVersion());
    return 0;
}

// `--help`/`-h` print the command reference on stdout and exit 0: asked-for help is
// output, not an error. A bare `dotnet meta` is still a usage error (stderr, exit 2).
bool helpRequested = args.Length > 0 && args[0] is "--help" or "-h";
if (args.Length == 0 || helpRequested)
{
    (helpRequested ? Console.Out : Console.Error).WriteLine(
        "usage: dotnet meta <command> [options]\n" +
        "  commands:\n" +
        "    init [--root <dir>]                              write codegen/Generators.cs (the generator list),\n" +
        "                                                     codegen/Program.cs and codegen/Codegen.csproj\n" +
        "    gen [<metadataDir>] --out <dir> [--namespace <ns>] [--emit-abstract-shapes]\n" +
        "        [--generators <a,b,c>] [--template-root <dir>]\n" +
        "                                                     run the generator list in codegen/Generators.cs;\n" +
        "                                                     --generators narrows it to the entries named\n" +
        "    gen --list                                       list available generators (stable names) and exit\n" +
        "    verify <metadataDir> [--templates [--prompts <dir>]] [--codegen --out <dir> [--namespace <ns>]] [--db] [--lax]\n" +
        "                                                     drift gates (ADR-0021 D2 subverbs):\n" +
        "                                                       --templates  template/prompt drift (default); the\n" +
        "                                                                    directory is --prompts <dir> or the inline\n" +
        "                                                                    root and must exist; with none it reads\n" +
        "                                                                    prompts/ if present, else templates/\n" +
        "                                                       --codegen    regen-to-temp vs committed --out\n" +
        "                                                       --namespace  codegen regen namespace; inferred\n" +
        "                                                                    from the committed --out when omitted\n" +
        "                                                       --db         NOT supported in C# (migrate engine)\n" +
        "                                                       --lax        load lax (legacy); strict-by-default\n" +
        "                                                                    rejects an unregistered @attr (ADR-0023)\n" +
        "                                                       --require-implementers\n" +
        "                                                                    the requirement gate runs on every verify;\n" +
        "                                                                    this raises a functional requirement nothing\n" +
        "                                                                    implements to an error (or\n" +
        "                                                                    META_REQUIRE_IMPLEMENTERS=1)\n" +
        "    eject <name>... [--force] [--root <dir>]        copy a reference generator into\n" +
        "                                                     codegen/generators/ to own (ADR-0034);\n" +
        "                                                     see `dotnet meta gen --list`\n" +
        "    fmt [<metadataDir>] [--check]                    rewrite metadata into canonical form (#304);\n" +
        "                                                     --check lists drift, exits non-zero, changes nothing\n" +
        "    agent-docs                                           see `npx meta agent-docs`\n" +
        "    --version, -v, -V                                print the version\n" +
        "    <command> --help                                 that command's usage");
    return helpRequested ? 0 : 2;
}

// `<command> --help` answers with that command's usage on stdout, exit 0, before the
// command parses anything — so help is never refused as an unknown flag.
if (args.Length > 1 && CommandUsage.TryGetValue(args[0], out var usage) && args[1..].Any(a => a is "--help" or "-h"))
{
    Console.WriteLine(usage);
    return 0;
}

return args[0] switch
{
    "gen" => RunGen(args[1..]),
    "verify" => RunVerify(args[1..]),
    "docs" => RemovedDocs(),
    "init" => RunInit(args[1..]),
    "fmt" => RunFmt(args[1..]),
    "eject" => RunEject(args[1..]),
    "agent-docs" => AgentDocsRedirect(),
    _ => Unknown(args[0]),
};

static int RunGen(string[] rest)
{
    string? metadataDir = null;
    var legacyDocs = new List<string>();
    for (int i = 0; i < rest.Length; i++)
    {
        // `--list` is the catalog: it needs no list and generates nothing.
        if (rest[i] == "--list")
        {
            Console.WriteLine(GenCommand.ListHeader);
            foreach (var line in GenCommand.ListLines(Directory.GetCurrentDirectory())) Console.WriteLine(line);
            return 0;
        }
        // A 1.0 docs flag is configuration that moved into codegen/Generators.cs (ADR-0034
        // Amendment 9), not an unknown flag: it is refused below with the line that says where.
        if (CodegenCli.LegacyDocsFlags.Contains(rest[i]))
        {
            if (!legacyDocs.Contains(rest[i])) legacyDocs.Add(rest[i]);
            if (i + 1 < rest.Length && !rest[i + 1].StartsWith('-')) i++;
        }
        else if (GenValueFlags.Contains(rest[i]))
        {
            if (i + 1 >= rest.Length) return RefuseFlag("gen", rest[i], GenValueFlags, GenBoolFlags);
            i++;
        }
        else if (rest[i].StartsWith("--baseline=", StringComparison.Ordinal) || GenBoolFlags.Contains(rest[i])) { }
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
        // An unrecognised flag used to be dropped here: `gen ... --bogus` generated and
        // exited 0, as if the flag had been honoured.
        else return RefuseFlag("gen", rest[i], GenValueFlags, GenBoolFlags);
    }

    // Before anything else: a run that still carries 1.0 docs flags would pass while writing
    // no documentation.
    if (legacyDocs.Count > 0)
    {
        Console.Error.WriteLine(CodegenCli.LegacyDocsConfiguration("dotnet meta gen", legacyDocs));
        return 2;
    }

    // An explicit <metadataDir> anchors the project on its parent — the directory holding
    // `metaobjects/`. With it omitted, the project is the directory gen runs in.
    var projectRoot = metadataDir is not null
        ? GenCommand.ProjectRootFor(metadataDir)
        : Directory.GetCurrentDirectory();
    if (RequireGeneratorList(projectRoot, "dotnet meta gen") is { } refused) return refused;

    // Advisory: nudge a re-scaffold if the copied-in agent context predates this build.
    // Never throws, never changes the exit code (a missing/corrupt manifest is ignored).
    AgentContextStalenessCheck.WarnIfStale(Directory.GetCurrentDirectory());

    // ADR-0034 Amendment 9: the list in codegen/Generators.cs is the run. The codegen project
    // validates every flag, resolves the metadata and writes; its exit code is this command's.
    CodegenHandoff.TryRun(projectRoot, ["gen", .. rest], out var handoffExit);
    return handoffExit;
}

// The one refusal for a gen or `verify --codegen` run in a project with no generator list.
// Null when the project has its list, the codegen project that compiles it, and a Program.cs
// that runs it.
static int? RequireGeneratorList(string projectRoot, string command)
{
    if (!CodegenHandoff.HasGeneratorList(projectRoot))
    {
        Console.Error.WriteLine(CodegenCli.NoGeneratorList(command));
        return 2;
    }
    if (!CodegenHandoff.HasOwnedCodegen(projectRoot))
    {
        Console.Error.WriteLine(
            $"{command}: codegen/Generators.cs has no codegen/Codegen.csproj to compile it. " +
            "`dotnet meta init` writes the missing files and keeps the ones you have.");
        return 2;
    }
    if (CodegenHandoff.ProgramIgnoresList(projectRoot))
    {
        Console.Error.WriteLine(CodegenCli.LegacyProgram(command));
        return 2;
    }
    return null;
}

// `dotnet meta docs` was removed in 1.1.0 (ADR-0034 Amendment 9). It prints the line that names
// the gen command and the migration section, and exits 2.
static int RemovedDocs()
{
    Console.Error.WriteLine(CodegenCli.DocsCommandRemoved);
    return 2;
}

// `dotnet meta init [--root <dir>]` — writes the codegen project that holds the generator list:
// codegen/Generators.cs, codegen/Program.cs and codegen/Codegen.csproj, each only when missing.
static int RunInit(string[] rest)
{
    string? root = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--root" && i + 1 < rest.Length) root = rest[++i];
        else return RefuseFlag("init", rest[i], ["--root"], []);
    }
    var result = InitCommand.Run(root ?? Directory.GetCurrentDirectory());
    foreach (var line in result) Console.WriteLine(line);
    return 0;
}

// `dotnet meta fmt [<metadataDir>] [--check]` — canonical formatting (#304).
// Takes the same optional <metadataDir> positional every other command does
// (an omitted one falls back to the .metaobjects/config.json ladder); unlike
// the TS reference, this port does not accept individual file arguments to
// narrow the run — FmtCommand.Run supports it (see its `explicitFiles`
// parameter), but no flag here surfaces it, matching this port's existing
// gen/verify/docs surface, which takes a directory, never a file list.
static int RunFmt(string[] rest)
{
    string? metadataDir = null;
    bool check = false;
    foreach (var a in rest)
    {
        if (a == "--check") check = true;
        else if (a.StartsWith('-')) return RefuseFlag("fmt", a, [], ["--check"]);
        else metadataDir ??= a;
    }

    var resolvedMeta = ResolveMetadataDirOrExit(metadataDir);
    var result = FmtCommand.Run(resolvedMeta, check);

    if (result.Fatal is not null)
    {
        Console.Error.WriteLine($"error: {result.Fatal}");
        return 1;
    }

    if (result.Files.Count == 0)
    {
        Console.WriteLine("dotnet meta fmt — no metadata files to format.");
        return 0;
    }

    foreach (var f in result.Files)
    {
        var rel = Path.GetRelativePath(Directory.GetCurrentDirectory(), f.Path);
        var line = f.Status switch
        {
            FmtCommand.FileStatus.Formatted => $"  reformatted  {rel}",
            FmtCommand.FileStatus.WouldFormat => $"  not canonical  {rel}",
            FmtCommand.FileStatus.Unchanged => $"  ok           {rel}",
            FmtCommand.FileStatus.SkippedYaml => $"  skipped (yaml)     {rel} — {f.Detail}",
            FmtCommand.FileStatus.SkippedOverlay => $"  skipped (overlay)  {rel} — this file declares an overlay fmt cannot resolve standalone",
            FmtCommand.FileStatus.Error => $"  error        {rel} — {f.Detail}",
            _ => $"  {f.Status}  {rel}",
        };
        Console.WriteLine(line);
    }

    var errored = result.Files.Count(f => f.Status == FmtCommand.FileStatus.Error);
    var needsFormat = result.Files.Count(f => f.Status == FmtCommand.FileStatus.WouldFormat);
    var reformatted = result.Files.Count(f => f.Status == FmtCommand.FileStatus.Formatted);

    if (check)
    {
        if (needsFormat > 0 || errored > 0)
        {
            Console.Error.WriteLine(
                $"dotnet meta fmt --check — {needsFormat} file(s) not canonical" +
                (errored > 0 ? $", {errored} error(s)" : "") +
                ". Run `dotnet meta fmt` to fix.");
            return 1;
        }
        Console.WriteLine("dotnet meta fmt --check — every file is already canonical.");
        return 0;
    }

    if (errored > 0)
    {
        Console.Error.WriteLine($"dotnet meta fmt — {errored} file(s) could not be formatted safely (left unchanged).");
        return 1;
    }

    Console.WriteLine($"dotnet meta fmt — {reformatted} file(s) reformatted.");
    return 0;
}

// `dotnet meta eject <name>...` — ADR-0034 Amendment 3. Parses --force / --root and
// delegates to EjectCommand.Run (pure logic); prints its report and returns its exit
// code. Deliberately does NOT run the metadataDir ladder (ResolveMetadataDirOrExit):
// eject touches only codegen/, never metadata.
static int RunEject(string[] rest)
{
    var names = new List<string>();
    bool force = false;
    string? root = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--force") force = true;
        else if (rest[i] == "--root" && i + 1 < rest.Length) root = rest[++i];
        else if (!rest[i].StartsWith('-')) names.Add(rest[i]);
        else return RefuseFlag("eject", rest[i], ["--root"], ["--force"]);
    }

    var result = EjectCommand.Run(names, root ?? Directory.GetCurrentDirectory(), force);
    foreach (var line in result.Out) Console.WriteLine(line);
    foreach (var line in result.Err) Console.Error.WriteLine($"error: {line}");
    return result.ExitCode;
}


// The metadata-location ladder's rungs 3-4 (source-resolution design doc §3):
// rung 1 is the explicit positional argument the caller already tried; rung 2
// (a port-native config surface) doesn't exist in C#; rungs 3 (a declared
// `sources` in .metaobjects/config.json) and 4 (the default "metaobjects"
// directory) live in MetaObjects.Config.MetadataLocation.Resolve,
// which this wraps. Called from all three metadataDir-taking commands (gen,
// docs, verify) so an omitted positional argument is never a hard requirement
// wherever a project's config can name the location instead.
//
// Never exits without a usable result: either hands back the resolved location or
// prints a diagnostic and terminates the process.
static ResolvedMetadata ResolveMetadataDirOrExit(string? metadataDir)
{
    // The ladder itself lives in MetaObjects.Config.MetadataLocation, shared with an
    // ejected codegen/Program.cs; this wrapper only turns its refusals into exit 2.
    try
    {
        return MetadataLocation.Resolve(metadataDir, Directory.GetCurrentDirectory());
    }
    catch (MetaObjects.MetaModelException e)
    {
        Console.Error.WriteLine($"error: {e.Code}: {e.Message}");
        Environment.Exit(2);
        throw;
    }
    catch (MetadataLocationException e)
    {
        Console.Error.WriteLine($"error: {e.Message}");
        Environment.Exit(2);
        throw;
    }
}

/// <summary>
/// The one refusal for a flag a command does not accept, in every command — the same
/// shape the Node <c>meta</c> CLI uses. A known value flag with its value missing says
/// so; anything else is named as unknown and the command's valid flags are listed, so the
/// refusal corrects itself in one step. Exit 2 (usage).
/// </summary>
static int RefuseFlag(string command, string flag, string[] valueFlags, string[] boolFlags)
{
    if (valueFlags.Contains(flag))
    {
        Console.Error.WriteLine($"dotnet meta {command}: {flag} needs a value");
        return 2;
    }
    var valid = valueFlags.Concat(boolFlags).Order(StringComparer.Ordinal);
    Console.Error.WriteLine(
        $"unknown flag {flag} for `dotnet meta {command}`. Valid flags: {string.Join(", ", valid)} " +
        "(also accepted everywhere: --help)");
    return 2;
}

static int Unknown(string cmd)
{
    Console.Error.WriteLine($"dotnet meta: unknown command \"{cmd}\"");
    return 2;
}

static int AgentDocsRedirect()
{
    Console.Error.WriteLine("agent-context scaffolding moved to the meta CLI — run: "
        + "npx meta agent-docs --server csharp [--client <fw>] [--out <dir>]");
    return 1;
}

// `dotnet meta verify` — ADR-0021 D2 explicit subverbs. Parses --templates /
// --codegen / --db, dispatches each requested gate via VerifyCommand.RunSubverbs
// (pure logic), and aggregates the exit code (max; non-zero on any drift). A bare
// `verify` runs the cross-port default set, templates + codegen, and prints a one-line note.
static int RunVerify(string[] rest)
{
    string? metadataDir = null;
    string? templatesRoot = null;
    string? outDir = null;
    string ns = "Generated";
    bool nsExplicit = false;
    string? generatorsCsv = null;
    string? templateRoot = null;
    string? columnNamingRaw = null;
    bool templates = false, codegen = false, db = false, lax = false, noFieldLint = false, requireImplementers = false;

    for (int i = 0; i < rest.Length; i++)
    {
        var a = rest[i];
        if (a == "--templates")
        {
            templates = true;
            // --templates may take an inline root, or fall back to a default below.
            if (i + 1 < rest.Length && !rest[i + 1].StartsWith('-')) templatesRoot = rest[++i];
        }
        // F101 — the prompt directory is spelled three ways across the ports: `--prompts <dir>`
        // (Node `meta`, the reference), `--templates-root` (the Python console-script) and
        // `--templates <root>` here, where it rides inline on the subverb's own flag. `--prompts`
        // is the converged spelling; it wins because overloading the subverb name is the part
        // that confuses. Setting it does NOT imply the gate — `--templates` still selects, so
        // `--prompts` alone is inert exactly as `--out` is without `--codegen`. The inline form
        // keeps working: the 1.0 CLI surface is frozen, so this is additive, and the old
        // spelling is deprecated in 1.1 and removed no earlier than a major.
        else if (a == "--prompts" && i + 1 < rest.Length) templatesRoot = rest[++i];
        else if (a == "--codegen") codegen = true;
        else if (a == "--db") db = true;
        // --lax (#96 / ADR-0023): restore the legacy open-attr load. verify is
        // strict-by-default — an undeclared/typo'd own @attr is ERR_UNKNOWN_ATTR.
        else if (a == "--lax") lax = true;
        // Mutes the advisory field AUTHORING lint (FieldLint) — never a gate, so this
        // changes what is printed and nothing else. META_NO_FIELD_LINT=1 does the same.
        else if (a == "--no-field-lint") noFieldLint = true;
        // Raises WARN_REQUIREMENT_NOTHING_IMPLEMENTS to an error (ADR-0057) — for a project whose
        // ledger has caught up with its links. META_REQUIRE_IMPLEMENTERS=1 does the same.
        else if (a == "--require-implementers") requireImplementers = true;
        else if (a == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (a == "--namespace" && i + 1 < rest.Length) { ns = rest[++i]; nsExplicit = true; }
        else if (a == "--generators" && i + 1 < rest.Length) generatorsCsv = rest[++i];
        else if (a == "--template-root" && i + 1 < rest.Length) templateRoot = rest[++i];
        // ADR-0058 — the flag is removed: column and table naming is one project setting
        // now, "naming" in .metaobjects/config.json, read by every port. Captured here (not
        // dropped as an unknown flag) so the refusal below can say exactly what the user gave.
        else if (a == "--column-naming" && i + 1 < rest.Length) columnNamingRaw = rest[++i];
        else if (a.StartsWith('-')) return RefuseFlag("verify", a, VerifyValueFlags, VerifyBoolFlags);
        else if (metadataDir is null) metadataDir = a;
        // A second positional is the templates root for a BARE verify
        // (`verify <metadataDir> <templatesRoot>`) — keeps the historical default
        // reachable without an explicit subverb (so the subverb note prints).
        else templatesRoot ??= a;
    }

    if (columnNamingRaw is not null)
    {
        Console.Error.WriteLine(CodegenCli.ColumnNamingFlagRemoved(columnNamingRaw));
        return 2;
    }

    // Rung 1 (explicit positional) is honored as-is; an omitted metadataDir
    // falls back to the port-neutral .metaobjects/config.json ladder.
    var resolvedMeta = ResolveMetadataDirOrExit(metadataDir);

    // The templates gate needs a root, and it must exist: a typo'd or absent directory used
    // to verify clean, because nothing in an empty root can drift. With none named (bare
    // verify, or a bare --templates) it reads the same default `gen` does: prompts/ when that
    // directory exists, else templates/ — and neither existing fails the same way.
    var bare = !templates && !codegen && !db;
    var wantsTemplates = templates || bare;
    if (wantsTemplates)
    {
        templatesRoot ??= GenCommand.DefaultTemplateRoot();
        if (!Directory.Exists(templatesRoot))
        {
            Console.Error.WriteLine($"dotnet meta verify --templates: templates directory not found: {templatesRoot}");
            Console.Error.WriteLine("  (name the directory that holds your prompt bodies, e.g. --templates ./prompts;");
            Console.Error.WriteLine("   with none named it reads prompts/ when that exists, else templates/)");
            return 2;
        }
    }

    // Advisory: nudge a re-scaffold if the copied-in agent context predates this build.
    // Never throws, never changes the exit code (a missing/corrupt manifest is ignored).
    AgentContextStalenessCheck.WarnIfStale(Directory.GetCurrentDirectory());

    var generators = generatorsCsv
        ?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    // ADR-0034 Amendment 9 hand-off, scoped to JUST the --codegen gate: the list in
    // codegen/Generators.cs is what codegen drift regenerates. --templates / --db do not
    // depend on the list, so they still run in-process below (opts.Codegen is cleared only
    // when the hand-off actually ran; a missing --out falls through to VerifyCommand's own
    // "no --out" usage message unchanged).
    var codegenHandedOff = false;
    var codegenHandoffExit = 0;
    var projectRoot = metadataDir is not null
        ? GenCommand.ProjectRootFor(metadataDir)
        : Directory.GetCurrentDirectory();
    // A bare verify also runs the codegen gate (the cross-port default set), but only when it
    // has what the gate cannot do without: the committed output (--out) and a generator list.
    // Lacking either it skips the gate with a note, where a named --codegen would refuse.
    if (bare)
    {
        if (outDir is null)
            Console.WriteLine("dotnet meta verify — codegen gate skipped: pass --out <dir> (the committed generated output to diff against) and have codegen/Generators.cs to run it");
        else if (!CodegenHandoff.HasGeneratorList(projectRoot))
            Console.WriteLine("dotnet meta verify — codegen gate skipped: no codegen/Generators.cs (the generator list) to regenerate from");
        else
            codegen = true;
    }
    if (codegen && outDir is not null)
    {
        // ADR-0034 Amendment 9: --codegen regenerates the list gen runs, so it needs that list.
        // A project without one fails this gate (exit 2) and only this gate: the requirement
        // gate below still runs, as it does on every verify.
        if (RequireGeneratorList(projectRoot, "dotnet meta verify --codegen") is { } refused)
        {
            codegenHandedOff = true;
            codegenHandoffExit = refused;
        }
        else
        {
            // Forward everything the owned runner's regen depends on. It resolves an omitted
            // <metadataDir> through the same ladder, so only an explicit one is passed on.
            // --generators narrows the declared list there exactly as it narrows gen's.
            List<string> codegenArgs = ["verify", "--codegen", "--out", outDir];
            if (metadataDir is not null) codegenArgs.Insert(2, metadataDir);
            if (nsExplicit) codegenArgs.AddRange(["--namespace", ns]);
            if (generatorsCsv is not null) codegenArgs.AddRange(["--generators", generatorsCsv]);
            if (templateRoot is not null) codegenArgs.AddRange(["--template-root", templateRoot]);
            if (lax) codegenArgs.Add("--lax");
            codegenHandedOff = CodegenHandoff.TryRun(projectRoot, codegenArgs.ToArray(), out codegenHandoffExit);
        }
    }

    var opts = new VerifyCommand.Options
    {
        MetadataDir = resolvedMeta.Directory,
        // A ladder-resolved source loads via this already-resolved,
        // `_pending`-excluded file list (see VerifyCommand.LoadMetadata) — never a
        // second (unfiltered) directory walk of MetadataDir.
        MetadataFiles = resolvedMeta.Files,
        // FR-043 — read regardless of ladder vs. explicit <metadataDir> (see
        // ResolveMetadataDirOrExit).
        Libraries = resolvedMeta.Libraries,
        // ADR-0058 — same source as Libraries; the --codegen gate's regen reads it from
        // the loaded root rather than a flag (see VerifyCommand.RunCodegenDrift).
        Naming = resolvedMeta.Naming,
        // ADR-0019 Amendment 2 — the wire setting, from the same file, for the --codegen regen.
        Wire = resolvedMeta.Wire ?? MetaObjects.Meta.WireFormat.Default,
        TemplatesRoot = templatesRoot,
        OutDir = outDir,
        Namespace = ns,
        NamespaceExplicit = nsExplicit,
        Generators = generators,
        TemplateRoot = templateRoot,
        Templates = templates,
        Bare = bare,
        Codegen = codegen && !codegenHandedOff,
        CodegenHandedOff = codegenHandedOff,
        Db = db,
        // #96 / ADR-0023: verify is strict-by-default; --lax restores the legacy load.
        Strict = !lax,
    };

    var result = VerifyCommand.RunSubverbs(opts);

    if (result.EmittedDefaultNote) Console.WriteLine(VerifyCommand.SUBVERB_NOTE);

    // #96 — when a strict load surfaced an unregistered @attr, print the actionable
    // three-exit hint once (register / attr.properties bag / --lax). Suppressed in
    // lax mode (the user already opted out of strict).
    var unknownAttr = MetaObjects.ErrorCode.ERR_UNKNOWN_ATTR.ToString();
    bool sawUnknownAttr =
        (result.Templates?.LoadErrors.Contains(unknownAttr) ?? false) ||
        (result.Codegen?.Error?.Contains(unknownAttr) ?? false);
    if (sawUnknownAttr && !lax) Console.Error.WriteLine($"  hint: {VerifyCommand.UNKNOWN_ATTR_HINT}");

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
            foreach (var line in MetaObjects.Codegen.CodegenDrift.Remedy(c)) Console.Error.WriteLine(line);
        }
    }

    // -- db gate (rejected in C#) --
    if (result.DbRejectionMessage is not null)
        Console.Error.WriteLine($"  {result.DbRejectionMessage}");

    // The requirement gate (ADR-0057) — on EVERY verify, whichever gates were selected, and not
    // muted by --no-field-lint. A model with no requirement.* node sees no line and no exit-code
    // change. Its errors fold into the exit code like any other gate's. It runs before the
    // advisory lint so the lint stays the last thing printed, as it was.
    //
    // A model that does not LOAD fails here, and is reported here unless a gate above already
    // printed that (result.LoadFailureReported). The handed-off codegen runner is another process
    // whose output this one cannot read, so its report is never assumed: when both it and this
    // load refuse the metadata, each says so.
    var requirementExit = VerifyCommand.RunRequirementGate(opts, requireImplementers, Console.Error, result.LoadFailureReported);

    // The field AUTHORING lint — a reference identity over a field the object lacks, a
    // field name declared twice in one children list. Both load clean on every port. Runs
    // on every `verify`, whichever gates were selected; warnings ONLY, never the exit code.
    if (!noFieldLint && Environment.GetEnvironmentVariable(FieldLint.EnvOptOut) != "1")
        FieldLint.RunAdvisory(resolvedMeta.Directory, resolvedMeta.Files, resolvedMeta.Libraries, Console.Error);

    // The handed-off codegen gate already printed its own verdict (inherited console);
    // fold its exit code into the aggregate the same way every other subverb does — max,
    // non-zero on any drift.
    var gatesExit = codegenHandedOff ? Math.Max(result.ExitCode, codegenHandoffExit) : result.ExitCode;
    return Math.Max(gatesExit, requirementExit);
}


/// <summary>The flags each command parses, for <see cref="RefuseFlag"/>. Kept beside the
/// parsers' own branches; a flag added to one must be added here.</summary>
partial class Program
{
    static readonly string[] GenValueFlags =
        ["--out", "--namespace", "--generators", "--template-root", "--template-spec", "--column-naming", "--baseline"];
    static readonly string[] GenBoolFlags = ["--list", "--emit-abstract-shapes"];
    static readonly string[] VerifyValueFlags =
        ["--prompts", "--out", "--namespace", "--generators", "--template-root", "--column-naming"];
    static readonly string[] VerifyBoolFlags = ["--templates", "--codegen", "--db", "--lax", "--no-field-lint", "--require-implementers"];

    /// <summary>Each command's usage, printed by <c>dotnet meta &lt;command&gt; --help</c>.</summary>
    static readonly Dictionary<string, string> CommandUsage = new()
    {
        ["gen"] = "usage: dotnet meta gen [<metadataDir>] --out <dir> [--namespace <ns>] [--generators <a,b,c>] [--template-root <dir>] [--emit-abstract-shapes] [--baseline default|adopt]\n" +
                  "       dotnet meta gen --list\n" +
                  "  runs the generator list in codegen/Generators.cs (`dotnet meta init` writes it);\n" +
                  "  --generators narrows that list to the entries named, and never adds one.\n" +
                  "  column/table naming: \"naming\" in .metaobjects/config.json (ADR-0058), not a flag here",
        ["init"] = "usage: dotnet meta init [--root <dir>]",
        ["verify"] = "usage: dotnet meta verify <metadataDir> [--templates [--prompts <dir>]] [--codegen --out <dir> [--namespace <ns>] [--generators <a,b,c>] [--template-root <dir>]] [--db] [--lax] [--no-field-lint] [--require-implementers]",
        ["fmt"] = "usage: dotnet meta fmt [<metadataDir>] [--check]",
        ["eject"] = "usage: dotnet meta eject <name>... [--force] [--root <dir>]",
    };
}
