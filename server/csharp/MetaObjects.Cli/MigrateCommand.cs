// `meta migrate` — two modes:
//   * default (no DB)       — emit the full-CREATE Postgres schema from metadata
//                             (current behavior; useful for scratch / CI).
//   * --from-db <conn>      — connect to a live Postgres, introspect, diff against
//                             the metadata-derived expected schema, and emit the
//                             incremental up + down migration SQL.
//
// Both paths are pure-logic functions returning a result record; Program.cs
// wraps console I/O so the command stays unit-testable.

using MetaObjects.Codegen.Migrate;
using MetaObjects.Codegen.Schema;
using MetaObjects.Loader;
using MetaObjects.Meta;

namespace MetaObjects.Cli;

/// <summary>The migrate command's pure logic (no console I/O), so it is testable.</summary>
public static class MigrateCommand
{
    /// <summary>Full-CREATE outcome (no DB).</summary>
    public sealed record Outcome(IReadOnlyList<string> LoadErrors, string? Sql, IReadOnlyList<string> Warnings)
    {
        public bool Ok => LoadErrors.Count == 0 && Sql is not null;
    }

    /// <summary>
    /// Incremental-migration outcome: <see cref="Up"/> and <see cref="Down"/> are
    /// the staged migration SQL; <see cref="Blocked"/> describes destructive/lossy
    /// changes that need an explicit allow-flag before <see cref="Up"/> can run.
    /// </summary>
    public sealed record IncrementalOutcome(
        IReadOnlyList<string> LoadErrors,
        string? Up,
        string? Down,
        IReadOnlyList<string> Blocked,
        IReadOnlyList<string> Warnings)
    {
        public bool Ok => LoadErrors.Count == 0 && Up is not null && Blocked.Count == 0;
    }

    /// <summary>Full-CREATE schema from metadata. No database connection required.</summary>
    public static Outcome Run(string metadataDir, string outFile)
    {
        var (loadErrors, root) = LoadRoot(metadataDir);
        if (root is null) return new Outcome(loadErrors, null, []);

        var warnings = new List<string>();
        var sql = PostgresSchema.BuildSchema(root, warnings.Add);
        File.WriteAllText(outFile, sql);
        return new Outcome(loadErrors, sql, warnings);
    }

    /// <summary>
    /// Incremental migration against a live database: introspect → diff → emit.
    /// The orchestrator takes an <see cref="IPgIntrospector"/> so a test can inject
    /// a stub (the CLI wires it to <see cref="NpgsqlIntrospector"/>).
    /// </summary>
    public static async Task<IncrementalOutcome> RunIncrementalAsync(
        string metadataDir,
        IPgIntrospector db,
        string? upOutFile = null,
        string? downOutFile = null,
        AllowOptions? allow = null)
    {
        var (loadErrors, root) = LoadRoot(metadataDir);
        if (root is null) return new IncrementalOutcome(loadErrors, null, null, [], []);

        var expected = ExpectedSchema.Build(root);
        var actual = await PostgresIntrospect.IntrospectAsync(db);
        var diff = SchemaDiff.Diff(expected, actual, allow);
        var emitted = PostgresEmit.Render(diff.Changes);

        // Nested-record Type.Name is already the short form ("DropColumn"); no Change+ prefix.
        var blocked = diff.Blocked
            .Select(c => $"{c.GetType().Name}: {c.Status.BlockedReason}")
            .ToList();

        if (upOutFile is not null) File.WriteAllText(upOutFile, emitted.Up);
        if (downOutFile is not null) File.WriteAllText(downOutFile, emitted.Down);

        return new IncrementalOutcome([], emitted.Up, emitted.Down, blocked, []);
    }

    private static (IReadOnlyList<string> Errors, MetaRoot? Root) LoadRoot(string metadataDir)
    {
        var load = new FileMetaDataLoader().LoadDirectory(metadataDir);
        var errs = load.Errors.Select(e => e.Code.ToString()).ToList();
        return (errs, errs.Count == 0 ? load.Root : null);
    }
}
