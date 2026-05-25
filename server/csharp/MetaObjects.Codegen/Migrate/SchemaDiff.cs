// SchemaDiff — compares an expected snapshot (from metadata) against an actual
// snapshot (from introspection) and produces the change list to bring actual →
// expected, with each change's status classified (destructive/lossy → blocked
// unless the matching AllowOptions flag is set).
//
// Ported from typescript/packages/migrate-ts/src/diff/index.ts + diff/status.ts.
// The rename heuristic (TS diff/rename-heuristic.ts) is deferred: drops + adds are
// emitted instead of renames. SqlType / ColumnDefault compare via record equality
// (scalar members); index / fk comparison is explicit because record equality does
// NOT deep-compare list members.

using System.Text.RegularExpressions;
using static MetaObjects.Persistence.Source.SourceConstants;

namespace MetaObjects.Codegen.Migrate;

/// <summary>Diffs two schema snapshots into a classified change list.</summary>
public static class SchemaDiff
{
    /// <summary>
    /// Produces the changes to bring <paramref name="actual"/> to <paramref name="expected"/>.
    /// Tables whose name matches an <paramref name="ignoreTables"/> pattern (exact or
    /// <c>*</c>-glob) are excluded from both sides. The default is empty by design; a
    /// live-DB caller should pass the migration-history table (e.g. <c>"__EFMigrationsHistory"</c>)
    /// so it isn't surfaced as a drop.
    /// </summary>
    public static DiffResult Diff(
        SchemaSnapshot expected,
        SchemaSnapshot actual,
        AllowOptions? allow = null,
        IReadOnlyList<string>? ignoreTables = null)
    {
        var ignore = ignoreTables ?? [];
        var changes = new List<Change>();

        var expectedTables = expected.Tables
            .Where(t => !ShouldIgnore(t.Name, ignore))
            .ToDictionary(TableIdentity);
        var actualTables = actual.Tables
            .Where(t => !ShouldIgnore(t.Name, ignore))
            .ToDictionary(TableIdentity);

        // Pass 1: in expected, not actual → create-table (+ its indexes + FKs as separate stmts).
        foreach (var (id, table) in expectedTables)
        {
            if (actualTables.ContainsKey(id)) continue;
            changes.Add(new Change.CreateTable(table));
            foreach (var index in table.Indexes)
                changes.Add(new Change.AddIndex(table.Name, index, table.Schema));
            foreach (var fk in table.ForeignKeys)
                changes.Add(new Change.AddFk(table.Name, fk, table.Schema));
        }
        // Pass 1b: in actual, not expected → drop-table.
        foreach (var (id, table) in actualTables)
            if (!expectedTables.ContainsKey(id))
                changes.Add(new Change.DropTable(table.Name, table.Schema));

        // Pass 2: in both → compare columns, indexes, FKs.
        foreach (var (id, expectedTable) in expectedTables)
        {
            if (!actualTables.TryGetValue(id, out var actualTable)) continue;
            DiffColumns(expectedTable, actualTable, changes);
            DiffIndexes(expectedTable, actualTable, changes);
            DiffForeignKeys(expectedTable, actualTable, changes);
        }

        ApplyStatus(changes, allow ?? new AllowOptions());
        return new DiffResult(changes, changes.Where(c => !c.Status.Allowed).ToList());
    }

    // Normalize a null schema to the Postgres default so an expected snapshot (often
    // null) compares equal to an introspected one (always populated).
    private static string TableIdentity(TableDescriptor t) =>
        (t.Schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + t.Name;

    private static bool ShouldIgnore(string name, IReadOnlyList<string> patterns) =>
        patterns.Any(p => TableMatches(name, p));

    private static bool TableMatches(string name, string pattern)
    {
        if (!pattern.Contains('*')) return name == pattern;
        var regex = "^" + Regex.Escape(pattern).Replace("\\*", ".*") + "$";
        return Regex.IsMatch(name, regex);
    }

    private static void DiffColumns(TableDescriptor expected, TableDescriptor actual, List<Change> changes)
    {
        var table = expected.Name;
        var schema = expected.Schema;
        var expectedCols = expected.Columns.ToDictionary(c => c.Name);
        var actualCols = actual.Columns.ToDictionary(c => c.Name);

        foreach (var (name, ec) in expectedCols)
        {
            if (!actualCols.TryGetValue(name, out var ac))
            {
                changes.Add(new Change.AddColumn(table, ec, schema));
                continue;
            }
            // SqlType and ColumnDefault are scalar-only records → structural ==.
            if (ec.SqlType != ac.SqlType)
                changes.Add(new Change.ChangeColumnType(table, name, ac.SqlType, ec.SqlType, schema));
            if (ec.Nullable != ac.Nullable)
                changes.Add(new Change.ChangeColumnNullable(table, name, ac.Nullable, ec.Nullable, schema));
            if (ec.Default != ac.Default)
                changes.Add(new Change.ChangeColumnDefault(table, name, ac.Default, ec.Default, schema));
            if (ec.Identity != ac.Identity)
                changes.Add(new Change.ChangeColumnIdentity(table, name, ac.Identity, ec.Identity, schema));
        }
        foreach (var (name, _) in actualCols)
            if (!expectedCols.ContainsKey(name))
                changes.Add(new Change.DropColumn(table, name, schema));
    }

    private static void DiffIndexes(TableDescriptor expected, TableDescriptor actual, List<Change> changes)
    {
        var table = expected.Name;
        var schema = expected.Schema;
        var expectedIdx = expected.Indexes.ToDictionary(i => i.Name);
        var actualIdx = actual.Indexes.ToDictionary(i => i.Name);

        foreach (var (name, ix) in expectedIdx)
        {
            if (!actualIdx.TryGetValue(name, out var a))
                changes.Add(new Change.AddIndex(table, ix, schema));
            else if (!IndexEquals(ix, a))
            {
                changes.Add(new Change.DropIndex(table, name, schema));
                changes.Add(new Change.AddIndex(table, ix, schema));
            }
        }
        foreach (var (name, _) in actualIdx)
            if (!expectedIdx.ContainsKey(name))
                changes.Add(new Change.DropIndex(table, name, schema));
    }

    private static void DiffForeignKeys(TableDescriptor expected, TableDescriptor actual, List<Change> changes)
    {
        var table = expected.Name;
        var schema = expected.Schema;
        var expectedFk = expected.ForeignKeys.ToDictionary(f => f.Name);
        var actualFk = actual.ForeignKeys.ToDictionary(f => f.Name);

        foreach (var (name, fk) in expectedFk)
        {
            if (!actualFk.TryGetValue(name, out var a))
                changes.Add(new Change.AddFk(table, fk, schema));
            else if (!FkEquals(fk, a))
            {
                changes.Add(new Change.DropFk(table, name, schema));
                changes.Add(new Change.AddFk(table, fk, schema));
            }
        }
        foreach (var (name, _) in actualFk)
            if (!expectedFk.ContainsKey(name))
                changes.Add(new Change.DropFk(table, name, schema));
    }

    // Explicit sequence comparison — record equality is reference-based on list members.
    private static bool IndexEquals(IndexDescriptor a, IndexDescriptor b) =>
        a.Unique == b.Unique && a.Columns.SequenceEqual(b.Columns);

    private static bool FkEquals(FkDescriptor a, FkDescriptor b) =>
        a.RefTable == b.RefTable && a.OnDelete == b.OnDelete && a.OnUpdate == b.OnUpdate &&
        a.Columns.SequenceEqual(b.Columns) && a.RefColumns.SequenceEqual(b.RefColumns);

    // Destructive/lossy changes default to blocked unless the matching flag is set.
    private static void ApplyStatus(IReadOnlyList<Change> changes, AllowOptions allow)
    {
        foreach (var c in changes)
        {
            var reason = BlockedReason(c, allow);
            c.Status = reason is null ? ChangeStatus.AllowedStatus : ChangeStatus.Block(reason);
        }
    }

    private static string? BlockedReason(Change c, AllowOptions allow) => c switch
    {
        Change.DropColumn => allow.DropColumn ? null : "destructive: drop-column not allowed (pass allow.dropColumn)",
        Change.DropTable => allow.DropTable ? null : "destructive: drop-table not allowed (pass allow.dropTable)",
        Change.DropIndex => allow.DropIndex ? null : "destructive: drop-index not allowed (pass allow.dropIndex)",
        Change.DropFk => allow.DropFk ? null : "destructive: drop-fk not allowed (pass allow.dropFk)",

        // Widening type changes are always allowed.
        Change.ChangeColumnType t when SqlType.IsWidening(t.From, t.To) || allow.TypeChange => null,
        Change.ChangeColumnType => "lossy type change (pass allow.typeChange)",

        // from = actual.nullable, to = expected.nullable; notnull→nullable is safe.
        Change.ChangeColumnNullable n when (!n.From && n.To) || allow.NullableToNotNull => null,
        Change.ChangeColumnNullable => "nullable→notnull requires existing data to satisfy (pass allow.nullableToNotNull)",

        _ => null,
    };
}
