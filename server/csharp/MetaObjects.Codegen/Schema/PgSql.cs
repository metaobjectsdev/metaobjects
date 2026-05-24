// PgSql — small Postgres-DDL string utilities shared by PostgresSchema (full
// schema build) and PostgresEmit (incremental migration). Internal-only; not
// part of the public API.

namespace MetaObjects.Codegen.Schema;

/// <summary>Shared Postgres-DDL string helpers.</summary>
internal static class PgSql
{
    /// <summary>Escape a string for use in a Postgres single-quoted string literal.</summary>
    public static string Escape(string s) => s.Replace("'", "''");
}
