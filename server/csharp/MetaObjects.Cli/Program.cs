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
        "    verify <metadataDir> [--templates <root>] [--codegen --out <dir> [--namespace <ns>]] [--db] [--lax]\n" +
        "                                                     drift gates (ADR-0021 D2 subverbs):\n" +
        "                                                       --templates  template/prompt drift (default)\n" +
        "                                                       --codegen    regen-to-temp vs committed --out\n" +
        "                                                       --namespace  codegen regen namespace; inferred\n" +
        "                                                                    from the committed --out when omitted\n" +
        "                                                       --db         NOT supported in C# (migrate engine)\n" +
        "                                                       --lax        load lax (legacy); strict-by-default\n" +
        "                                                                    rejects an unregistered @attr (ADR-0023)\n" +
        "    docs <metadataDir> --out <dir> [--namespace <ns>] [--project <name>] [--model-base-url <url>]\n" +
        "                                                     emit the generated C# SDK api reference\n" +
        "                                                     (the api/csharp surface: one page per\n" +
        "                                                     entity + template, README, AGENT-API)\n" +
        "    agent-docs                                           see `npx meta agent-docs`");
    return 2;
}

return args[0] switch
{
    "gen" => RunGen(args[1..]),
    "verify" => RunVerify(args[1..]),
    "docs" => RunDocs(args[1..]),
    "agent-docs" => AgentDocsRedirect(),
    _ => Unknown(args[0]),
};

static int RunGen(string[] rest)
{
    string? metadataDir = null;
    string? outDir = null;
    string ns = GenCommand.DefaultNamespace;
    bool emitAbstractShapes = false;
    bool list = false;
    string? generatorsCsv = null;
    string? templateRoot = null;
    string? templateSpecPath = null;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--list") list = true;
        else if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (rest[i] == "--namespace" && i + 1 < rest.Length) ns = rest[++i];
        else if (rest[i] == "--generators" && i + 1 < rest.Length) generatorsCsv = rest[++i];
        else if (rest[i] == "--template-root" && i + 1 < rest.Length) templateRoot = rest[++i];
        else if (rest[i] == "--template-spec" && i + 1 < rest.Length) templateSpecPath = rest[++i];
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

    // Usage-first: a missing --out is a plain CLI-usage error, unconditional on
    // whether metadata can be found — it must win over ResolveMetadataDirOrExit
    // below, which can itself terminate the process with an unrelated
    // ERR_COLLECTION_NOT_FOUND. Checking outDir after resolution would show that
    // confusing error instead of this actionable usage line on the (common)
    // first-run case where BOTH are missing.
    if (outDir is null)
    {
        Console.Error.WriteLine("usage: dotnet meta gen <metadataDir> --out <dir> [--namespace <ns>] [--generators <a,b,c>] [--template-root <dir>] [--template-spec <json>] [--emit-abstract-shapes]");
        Console.Error.WriteLine("       dotnet meta gen --list");
        return 2;
    }

    // Rung 1 (explicit positional) is honored as-is; an omitted metadataDir
    // falls back to the port-neutral .metaobjects/config.json ladder.
    var resolvedMeta = ResolveMetadataDirOrExit(metadataDir);

    // Advisory: nudge a re-scaffold if the copied-in agent context predates this build.
    // Never throws, never changes the exit code (a missing/corrupt manifest is ignored).
    AgentContextStalenessCheck.WarnIfStale(Directory.GetCurrentDirectory());

    var generatorNames = generatorsCsv
        ?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    // A ladder-resolved (non-null Files) source loads via the already-resolved,
    // `_pending`-excluded file list (MetaDataLoader.FromUris) — never a second
    // FromDirectory walk of resolvedMeta.Directory, which would both duplicate
    // the walk ResolveMetadataDirOrExit already did AND silently include `_pending`.
    // Where the `.gen-state/.hashes.json` manifest goes. An explicit <metadataDir>
    // anchors on its parent — the directory holding `metaobjects/`. With it omitted,
    // the `.metaobjects/config.json` ladder above resolved everything relative to cwd,
    // so cwd IS the project. Never cwd unconditionally: that scattered a stray
    // `.metaobjects/` into any directory this ran from.
    var projectRoot = metadataDir is not null
        ? GenCommand.ProjectRootFor(metadataDir)
        : Directory.GetCurrentDirectory();

    var outcome = resolvedMeta.Files is { } files
        ? GenCommand.Run(
            MetaObjects.Loader.MetaDataLoader.FromUris(files.Select(f => new Uri(f)).ToList()),
            outDir, ns, emitAbstractShapes, generatorNames, templateRoot, templateSpecPath, projectRoot)
        : GenCommand.Run(
            resolvedMeta.Directory, outDir, ns, emitAbstractShapes, generatorNames, templateRoot, templateSpecPath);
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
    // Default the documented namespace to the SAME default `dotnet meta gen` uses, so the
    // rendered `using <ns>;` import lines match what an adopter writes against generated code.
    string ns = GenCommand.DefaultNamespace;
    for (int i = 0; i < rest.Length; i++)
    {
        if (rest[i] == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (rest[i] == "--namespace" && i + 1 < rest.Length) ns = rest[++i];
        else if (rest[i] == "--project" && i + 1 < rest.Length) project = rest[++i];
        else if (rest[i] == "--model-base-url" && i + 1 < rest.Length) modelBaseUrl = rest[++i];
        else if (!rest[i].StartsWith('-')) metadataDir ??= rest[i];
    }

    // Usage-first — see the identical comment in RunGen above; a missing --out
    // must win over ResolveMetadataDirOrExit's own possible ERR_COLLECTION_NOT_FOUND.
    if (outDir is null)
    {
        Console.Error.WriteLine("usage: dotnet meta docs <metadataDir> --out <dir> [--namespace <ns>] [--project <name>] [--model-base-url <url>]");
        return 2;
    }

    // Rung 1 (explicit positional) is honored as-is; an omitted metadataDir
    // falls back to the port-neutral .metaobjects/config.json ladder.
    var resolvedMeta = ResolveMetadataDirOrExit(metadataDir);

    // Default the project label to the input directory's leaf name (cosmetic — surfaces
    // in the AGENT-API header). Trailing-separator-safe.
    project ??= new DirectoryInfo(Path.TrimEndingDirectorySeparator(Path.GetFullPath(resolvedMeta.Directory))).Name;

    // See the identical comment in RunGen above: a ladder-resolved source loads
    // via its already-resolved, `_pending`-excluded file list, never a second
    // (unfiltered) directory walk.
    var outcome = resolvedMeta.Files is { } files
        ? DocsCommand.Run(
            MetaObjects.Loader.MetaDataLoader.FromUris(files.Select(f => new Uri(f)).ToList()),
            outDir, project, ns, modelBaseUrl: modelBaseUrl)
        : DocsCommand.Run(resolvedMeta.Directory, outDir, project, ns, modelBaseUrl: modelBaseUrl);
    if (!outcome.Ok)
    {
        foreach (var e in outcome.LoadErrors) Console.Error.WriteLine($"  load error: {e}");
        if (outcome.CollisionError is not null)
        {
            Console.Error.WriteLine($"  {outcome.CollisionError}");
            Console.Error.WriteLine("dotnet meta docs: FAILED (duplicate api page output path)");
            return 1;
        }
        Console.Error.WriteLine("dotnet meta docs: FAILED (metadata did not load cleanly)");
        return 1;
    }
    foreach (var p in outcome.WrittenPaths) Console.WriteLine($"  written: {p}");
    Console.WriteLine($"dotnet meta docs: {outcome.WrittenPaths.Count} api page(s) written");
    return 0;
}

// The metadata-location ladder's rungs 3-4 (source-resolution design doc §3):
// rung 1 is the explicit positional argument the caller already tried; rung 2
// (a port-native config surface) doesn't exist in C#; rungs 3 (a declared
// `sources` in .metaobjects/config.json) and 4 (the default "metaobjects"
// directory) live in MetaObjects.Config.SourceResolver.ResolveCollection,
// which this wraps. Called from all three metadataDir-taking commands (gen,
// docs, verify) so an omitted positional argument is never a hard requirement
// wherever a project's config can name the location instead.
//
// The metadata-location ladder's result: always a directory (explicit-arg
// back-compat, and cosmetic labeling even on the ladder path), and — when
// resolution went through the .metaobjects/config.json ladder rather than an
// explicit CLI argument — the ladder's OWN already-resolved, `_pending`-draft-
// excluded file list too. A caller with a non-null Files must load via
// MetaDataLoader.FromUris(Files) rather than FromDirectory(Directory): the
// latter would both re-walk a tree this function already walked once (via
// SourceResolver) AND silently lose the `_pending` exclusion, since
// DirectorySource.Options.ExcludePending defaults to false at the loader
// level (SourceResolver is the one place that turns it on). Declared at file
// scope below the entry point (top-level-statement files require type
// declarations to follow every top-level statement / local function).

// Never exits without a usable result: either hands back a real directory
// (+ file list, when ladder-resolved), or prints a diagnostic and terminates
// the process — callers may treat the result as always-present and keep
// their existing (now-unreachable-when-omitted) null checks for the OTHER
// positional/option they still require.
static ResolvedMetadata ResolveMetadataDirOrExit(string? metadataDir)
{
    if (metadataDir is not null) return new ResolvedMetadata(metadataDir, null);

    var cwd = Directory.GetCurrentDirectory();
    try
    {
        var cfg = MetaObjects.Config.NeutralConfig.Read(cwd);
        var specs = cfg?.Sources ?? Array.Empty<IReadOnlyDictionary<string, string>>();

        if (specs.Count == 0)
        {
            // No declared sources — resolve + apply the DEFAULT directory through
            // the same ladder the shared conformance corpus gates (raises
            // ERR_COLLECTION_NOT_FOUND when the default is also absent). The
            // returned file list IS the load — no second walk needed.
            var defaultFiles = MetaObjects.Config.SourceResolver.ResolveCollection(cwd);
            return new ResolvedMetadata(
                Path.Combine(cwd, MetaObjects.Config.NeutralConfig.DefaultMetadataDir), defaultFiles);
        }

        if (specs.Count > 1)
        {
            // MetaDataLoader.FromDirectory takes ONE directory — it cannot express a
            // multi-source SET. Fail loudly rather than silently loading just one of
            // the declared sources; MetaDataLoader.Load(IReadOnlyList<IMetaDataSource>)
            // (MetaDataLoader.cs:334) is the documented follow-up that lifts this.
            Console.Error.WriteLine(
                $"error: {cwd}: .metaobjects/config.json declares {specs.Count} metadata sources, but " +
                "this CLI's loader accepts only one directory at a time. Pass <metadataDir> explicitly, " +
                "or reduce \"sources\" to a single entry.");
            Environment.Exit(2);
            throw new InvalidOperationException("unreachable");
        }

        // Exactly one declared source. Resolve + validate it through the same
        // kind/existence checks ResolveSources applies (ERR_SOURCE_KIND_UNSUPPORTED /
        // ERR_SOURCE_UNRESOLVED) — its return value IS the (already `_pending`-
        // excluded) file list to load, not just a validation signal to discard.
        var files = MetaObjects.Config.SourceResolver.ResolveSources(cwd, specs);
        var rawPath = specs[0]["path"]; // guaranteed present: ResolveSources above
                                         // would already have thrown otherwise.
        var resolved = Path.IsPathRooted(rawPath) ? rawPath : Path.GetFullPath(Path.Combine(cwd, rawPath));

        if (!Directory.Exists(resolved))
        {
            // ResolveSources above already proved `resolved` exists, so this means
            // it is a FILE. MetaDataLoader.FromDirectory below takes a directory —
            // handing it a file path used to fail deep inside DirectorySource with
            // an opaque ERR_UNKNOWN instead of naming the actual limit. Refuse
            // clearly here instead, the same way the multi-source branch above does.
            Console.Error.WriteLine(
                $"error: {cwd}: .metaobjects/config.json's single \"sources\" entry (\"{rawPath}\") is a FILE, " +
                "but this CLI's loader only accepts a directory source. Pass <metadataDir> explicitly, or point " +
                "\"sources\" at the file's containing directory.");
            Environment.Exit(2);
            throw new InvalidOperationException("unreachable");
        }

        return new ResolvedMetadata(resolved, files);
    }
    catch (MetaObjects.MetaModelException e)
    {
        Console.Error.WriteLine($"error: {e.Code}: {e.Message}");
        Environment.Exit(2);
        throw;
    }
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
    bool templates = false, codegen = false, db = false, lax = false;

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
        // --lax (#96 / ADR-0023): restore the legacy open-attr load. verify is
        // strict-by-default — an undeclared/typo'd own @attr is ERR_UNKNOWN_ATTR.
        else if (a == "--lax") lax = true;
        else if (a == "--out" && i + 1 < rest.Length) outDir = rest[++i];
        else if (a == "--namespace" && i + 1 < rest.Length) { ns = rest[++i]; nsExplicit = true; }
        else if (a == "--generators" && i + 1 < rest.Length) generatorsCsv = rest[++i];
        else if (a == "--template-root" && i + 1 < rest.Length) templateRoot = rest[++i];
        else if (a.StartsWith('-'))
        {
            Console.Error.WriteLine($"dotnet meta verify: unknown option \"{a}\"");
            Console.Error.WriteLine("usage: dotnet meta verify <metadataDir> [--templates <root>] [--codegen --out <dir> [--namespace <ns>]] [--db] [--lax]");
            return 2;
        }
        else if (metadataDir is null) metadataDir = a;
        // A second positional is the templates root for a BARE verify
        // (`verify <metadataDir> <templatesRoot>`) — keeps the historical default
        // reachable without an explicit subverb (so the subverb note prints).
        else templatesRoot ??= a;
    }

    // Rung 1 (explicit positional) is honored as-is; an omitted metadataDir
    // falls back to the port-neutral .metaobjects/config.json ladder.
    var resolvedMeta = ResolveMetadataDirOrExit(metadataDir);

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
        MetadataDir = resolvedMeta.Directory,
        // A ladder-resolved source loads via this already-resolved,
        // `_pending`-excluded file list (see VerifyCommand.LoadMetadata) — never a
        // second (unfiltered) directory walk of MetadataDir.
        MetadataFiles = resolvedMeta.Files,
        TemplatesRoot = templatesRoot,
        OutDir = outDir,
        Namespace = ns,
        NamespaceExplicit = nsExplicit,
        Generators = generators,
        TemplateRoot = templateRoot,
        Templates = templates,
        Codegen = codegen,
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
            Console.Error.WriteLine("Run 'dotnet meta gen' to regenerate, then commit the result.");
        }
    }

    // -- db gate (rejected in C#) --
    if (result.DbRejectionMessage is not null)
        Console.Error.WriteLine($"  {result.DbRejectionMessage}");

    return result.ExitCode;
}

// See the doc comment on ResolveMetadataDirOrExit above.
readonly record struct ResolvedMetadata(string Directory, IReadOnlyList<string>? Files);
