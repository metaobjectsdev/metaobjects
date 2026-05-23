// `meta migrate` — emit Postgres schema DDL (CREATE TABLE + CREATE VIEW) from
// metadata. (Schema diff against a live database is a later increment; this emits
// the create-schema DDL deterministically from the model.)

using MetaObjects.Codegen.Schema;
using MetaObjects.Loader;

namespace MetaObjects.Cli;

/// <summary>The migrate command's pure logic (no console I/O), so it is testable.</summary>
public static class MigrateCommand
{
    public sealed record Outcome(IReadOnlyList<string> LoadErrors, string? Sql, IReadOnlyList<string> Warnings)
    {
        public bool Ok => LoadErrors.Count == 0 && Sql is not null;
    }

    public static Outcome Run(string metadataDir, string outFile)
    {
        var load = new FileMetaDataLoader().LoadDirectory(metadataDir);
        var loadErrors = load.Errors.Select(e => e.Code.ToString()).ToList();
        if (loadErrors.Count > 0)
            return new Outcome(loadErrors, null, []);

        var warnings = new List<string>();
        var sql = PostgresSchema.BuildSchema(load.Root, warnings.Add);
        File.WriteAllText(outFile, sql);
        return new Outcome(loadErrors, sql, warnings);
    }
}
