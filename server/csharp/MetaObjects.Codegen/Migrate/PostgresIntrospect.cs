// PostgresIntrospect — stage 2 of the migration pipeline.
//
// Reads a live Postgres database via the IPgIntrospector abstraction and produces
// a SchemaSnapshot the engine can compare against ExpectedSchema. Two concerns
// are split deliberately:
//
//   - Pure parsing helpers (PgTypeToSqlType, ParsePgDefault, PgRuleToAction)
//     transform Postgres-side strings into the canonical engine types. No I/O,
//     fully unit-testable.
//   - The orchestrator (IntrospectAsync) calls each information_schema / pg_*
//     query through the IPgIntrospector interface and assembles a SchemaSnapshot.
//     Production wires the interface to Npgsql; tests inject a FakePgIntrospector
//     with canned rows.
//
// Ported from typescript/packages/migrate-ts/src/introspect/postgres.ts.

using System.Text.RegularExpressions;
using static MetaObjects.Persistence.Source.SourceConstants;

namespace MetaObjects.Codegen.Migrate;

/// <summary>One row from a Postgres query, indexed by lowercase column name.</summary>
public sealed class PgRow
{
    private readonly IReadOnlyDictionary<string, object?> _byName;

    public PgRow(IReadOnlyDictionary<string, object?> byName) => _byName = byName;

    /// <summary>Convenience constructor for tests.</summary>
    public static PgRow Of(params (string Name, object? Value)[] cells) =>
        new(cells.ToDictionary(c => c.Name, c => c.Value, StringComparer.OrdinalIgnoreCase));

    public string? GetString(string column) => _byName.TryGetValue(column, out var v) ? v?.ToString() : null;
    public bool GetBool(string column) => _byName.TryGetValue(column, out var v) && v is true;

    /// <summary>Coerce numeric values (PG int2/int4/int8 surface as short/int/long).</summary>
    public long? GetLong(string column) => _byName.TryGetValue(column, out var v) ? v switch
    {
        long l => l,
        int i => i,
        short s => s,
        null => null,
        _ => long.TryParse(v.ToString(), out var p) ? p : null,
    } : null;
}

/// <summary>
/// Abstraction over a Postgres connection sized to introspection only. Production
/// wires this to Npgsql in MetaObjects.Cli; tests use a fake that returns canned
/// rows. Parameter placeholders use Npgsql's <c>@name</c> form.
/// </summary>
public interface IPgIntrospector
{
    Task<IReadOnlyList<PgRow>> QueryAsync(string sql, params (string Name, object? Value)[] parameters);
}

/// <summary>Pure parsing helpers + introspection orchestrator.</summary>
public static class PostgresIntrospect
{
    // -----------------------------------------------------------------------
    // Pure helpers — exported for direct unit-testing
    // -----------------------------------------------------------------------

    // Length-bearing varchar form: "character varying(255)" or "varchar(255)".
    private static readonly Regex VarcharInline = new(
        @"^(?:character varying|varchar)\((\d+)\)$", RegexOptions.Compiled);

    // "numeric(p,s)" / "numeric(p)" / bare "numeric"|"decimal".
    private static readonly Regex NumericInline = new(
        @"^(?:numeric|decimal)(?:\((\d+)(?:,\s*(\d+))?\))?$", RegexOptions.Compiled);

    /// <summary>
    /// Normalize a Postgres data-type string into a canonical <see cref="SqlType"/>.
    /// <paramref name="dataType"/> is what <c>information_schema.columns.data_type</c>
    /// returns (occasionally <c>udt_name</c>); both are lower-cased before matching.
    /// Unknown types fall back to <see cref="SqlType.Text"/> rather than throwing.
    /// </summary>
    public static SqlType PgTypeToSqlType(string dataType, long? maxLength = null)
    {
        var dt = dataType.Trim().ToLowerInvariant();

        var varchar = VarcharInline.Match(dt);
        if (varchar.Success) return new SqlType.Text(long.Parse(varchar.Groups[1].Value));
        if (dt is "character varying" or "varchar")
            return maxLength is { } n ? new SqlType.Text(n) : new SqlType.Text();
        if (dt == "text") return new SqlType.Text();

        if (dt is "int8" or "bigint" or "bigserial") return new SqlType.Integer(64);
        if (dt is "int4" or "integer" or "int" or "serial"
              or "int2" or "smallint" or "smallserial")
            return new SqlType.Integer(32);

        if (dt is "float4" or "real") return new SqlType.Real();
        if (dt is "float8" or "double precision") return new SqlType.Real();

        var num = NumericInline.Match(dt);
        if (num.Success)
        {
            long? precision = num.Groups[1].Success ? long.Parse(num.Groups[1].Value) : null;
            long? scale = num.Groups[2].Success ? long.Parse(num.Groups[2].Value) : null;
            return new SqlType.Numeric(precision, scale);
        }

        if (dt is "bool" or "boolean") return new SqlType.Boolean();
        if (dt == "date") return new SqlType.Date();
        if (dt is "timestamp" or "timestamp without time zone") return new SqlType.Timestamp(false);
        if (dt is "timestamptz" or "timestamp with time zone") return new SqlType.Timestamp(true);
        if (dt is "json" or "jsonb") return new SqlType.Json();
        if (dt == "bytea") return new SqlType.Blob();
        if (dt == "uuid") return new SqlType.Uuid();

        // Unknown user-defined types (enums, citext, ltree, ...) fall back to text.
        return new SqlType.Text();
    }

    // Function-call / keyword expressions Postgres stores as defaults.
    private static readonly Regex ExprPrefix = new(
        @"^(?:now\(\)|current_timestamp|current_date|current_time|nextval\()",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Trailing ::type cast Postgres often appends to literal defaults.
    private static readonly Regex TrailingCast = new(@"::[^']+$", RegexOptions.Compiled);

    /// <summary>
    /// Parse a raw <c>information_schema.columns.column_default</c> value into a
    /// <see cref="ColumnDefault"/>, classifying it as an SQL expression or a literal.
    /// Returns null for absent/empty defaults.
    /// </summary>
    public static ColumnDefault? ParsePgDefault(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        if (ExprPrefix.IsMatch(raw)) return new ColumnDefault(DefaultKind.Expr, raw);

        if (raw.StartsWith('\''))
        {
            // Strip the trailing ::type cast, then the surrounding single-quotes.
            var withoutCast = TrailingCast.Replace(raw, "");
            var cleaned = withoutCast.Length >= 2 && withoutCast[0] == '\'' && withoutCast[^1] == '\''
                ? withoutCast[1..^1]
                : withoutCast;
            return new ColumnDefault(DefaultKind.Literal, cleaned);
        }

        // Bare value containing :: is an expression (NULL::text, ARRAY[]::text[], ...).
        if (raw.Contains("::")) return new ColumnDefault(DefaultKind.Expr, raw);

        // Bare value without quotes or cast — a literal.
        return new ColumnDefault(DefaultKind.Literal, raw);
    }

    /// <summary>
    /// Translate a Postgres <c>information_schema.referential_constraints</c> rule
    /// (CASCADE / SET NULL / RESTRICT / NO ACTION) to an <see cref="FkAction"/>.
    /// Returns null for NO ACTION so emitters omit the clause — matches ExpectedSchema's
    /// normalization (a no-op default isn't worth a diff).
    /// </summary>
    public static FkAction? PgRuleToAction(string rule) => rule.Trim().ToUpperInvariant() switch
    {
        "CASCADE" => FkAction.Cascade,
        "SET NULL" => FkAction.SetNull,
        "RESTRICT" => FkAction.Restrict,
        _ => null,
    };

    // -----------------------------------------------------------------------
    // Orchestrator
    // -----------------------------------------------------------------------

    /// <summary>
    /// Build a <see cref="SchemaSnapshot"/> from a live Postgres database via
    /// <paramref name="db"/>. Tables come from <c>information_schema.tables</c>
    /// (BASE TABLE only); columns / PKs / indexes / FKs are fetched per-table.
    /// User schemas only (<c>pg_*</c> + <c>information_schema</c> excluded).
    /// </summary>
    public static async Task<SchemaSnapshot> IntrospectAsync(IPgIntrospector db)
    {
        var tableRefs = await ReadTablesAsync(db);
        var tables = new List<TableDescriptor>();
        foreach (var (schema, name) in tableRefs)
        {
            var columns = await ReadColumnsAsync(db, schema, name);
            var primaryKey = await ReadPrimaryKeyAsync(db, schema, name);
            var indexes = await ReadIndexesAsync(db, schema, name);
            var foreignKeys = await ReadForeignKeysAsync(db, schema, name);
            tables.Add(new TableDescriptor(
                Name: name,
                Columns: columns,
                Indexes: indexes,
                ForeignKeys: foreignKeys,
                PrimaryKey: primaryKey,
                // Drop the "public" schema label so an introspected snapshot compares
                // equal to an expected snapshot that left @schema unset (the engine
                // already normalizes public → null at the diff/emit boundary, but
                // matching the expected shape avoids surprise in trace output).
                Schema: schema == DEFAULT_DB_SCHEMA_POSTGRES ? null : schema));
        }
        return new SchemaSnapshot(tables);
    }

    // -----------------------------------------------------------------------
    // Per-query readers (SQL is hand-written to avoid ORM-specific operators
    // that some test substrates — pg-mem etc. — don't implement)
    // -----------------------------------------------------------------------

    private const string TablesSql = """
        SELECT table_name, table_schema
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_schema NOT LIKE 'pg_%'
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
        """;

    private const string ColumnsSql = """
        SELECT
          column_name,
          data_type,
          udt_name,
          character_maximum_length,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = @schema
          AND table_name = @table
        ORDER BY ordinal_position
        """;

    private const string PrimaryKeySql = """
        SELECT kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema   = tc.table_schema
          AND kcu.table_name     = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema    = @schema
          AND tc.table_name      = @table
        ORDER BY kcu.ordinal_position
        """;

    private const string IndexesSql = """
        SELECT i.relname AS index_name,
               ix.indisunique AS is_unique,
               ix.indisprimary AS is_primary,
               a.attname AS column_name,
               array_position(ix.indkey, a.attnum) AS ordinal
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname = @schema
          AND t.relname = @table
        ORDER BY i.relname, ordinal
        """;

    private const string ForeignKeysSql = """
        SELECT tc.constraint_name AS fk_name,
               kcu.column_name,
               ccu.table_name AS ref_table,
               ccu.column_name AS ref_column,
               rc.update_rule,
               rc.delete_rule,
               kcu.ordinal_position AS ordinal
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name
          AND rc.constraint_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = @schema
          AND tc.table_name = @table
        ORDER BY tc.constraint_name, kcu.ordinal_position
        """;

    private static async Task<List<(string Schema, string Name)>> ReadTablesAsync(IPgIntrospector db)
    {
        var rows = await db.QueryAsync(TablesSql);
        return rows.Select(r => (r.GetString("table_schema")!, r.GetString("table_name")!)).ToList();
    }

    private static async Task<List<ColumnDescriptor>> ReadColumnsAsync(IPgIntrospector db, string schema, string table)
    {
        var rows = await db.QueryAsync(ColumnsSql, ("schema", schema), ("table", table));
        var cols = new List<ColumnDescriptor>();
        foreach (var r in rows)
        {
            var dataType = r.GetString("data_type") ?? "text";
            var udtName = r.GetString("udt_name") ?? "";
            var maxLen = r.GetLong("character_maximum_length");
            var sqlType = PgTypeToSqlType(dataType, maxLen);
            var nullable = string.Equals(r.GetString("is_nullable"), "YES", StringComparison.OrdinalIgnoreCase);
            var rawDefault = r.GetString("column_default");
            var def = ParsePgDefault(rawDefault);
            // bigserial / serial / smallserial surface as a nextval(...) default OR
            // as the udt_name. Belt-and-suspenders detection.
            var isSerial = (rawDefault is not null && rawDefault.StartsWith("nextval(", StringComparison.OrdinalIgnoreCase))
                || udtName.Equals("bigserial", StringComparison.OrdinalIgnoreCase)
                || udtName.Equals("serial8", StringComparison.OrdinalIgnoreCase)
                || udtName.Equals("serial4", StringComparison.OrdinalIgnoreCase)
                || udtName.Equals("serial", StringComparison.OrdinalIgnoreCase)
                || udtName.Equals("smallserial", StringComparison.OrdinalIgnoreCase)
                || udtName.Equals("serial2", StringComparison.OrdinalIgnoreCase);
            // When a column's default is the sequence-feeder (nextval(...)) and we've
            // already flagged the column as identity=increment, suppress the default so
            // the snapshot matches ExpectedSchema (which models the serial column as
            // identity-only). Otherwise the diff would always see a spurious
            // ChangeColumnDefault for every serial PK.
            var defForSnapshot = (isSerial && def is { Kind: DefaultKind.Expr } e
                                          && e.Value.StartsWith("nextval(", StringComparison.OrdinalIgnoreCase))
                ? null
                : def;
            cols.Add(new ColumnDescriptor(
                Name: r.GetString("column_name")!,
                SqlType: sqlType,
                Nullable: nullable,
                Default: defForSnapshot,
                Identity: isSerial ? IdentityKind.Increment : null));
        }
        return cols;
    }

    private static async Task<List<string>> ReadPrimaryKeyAsync(IPgIntrospector db, string schema, string table)
    {
        var rows = await db.QueryAsync(PrimaryKeySql, ("schema", schema), ("table", table));
        return rows.Select(r => r.GetString("column_name")!).ToList();
    }

    private static async Task<List<IndexDescriptor>> ReadIndexesAsync(IPgIntrospector db, string schema, string table)
    {
        var rows = await db.QueryAsync(IndexesSql, ("schema", schema), ("table", table));
        // Group rows by index name, ordered by `ordinal` (already done by ORDER BY).
        var byName = new Dictionary<string, (bool IsUnique, bool IsPrimary, List<string> Cols)>(StringComparer.Ordinal);
        foreach (var r in rows)
        {
            var name = r.GetString("index_name")!;
            if (!byName.TryGetValue(name, out var entry))
            {
                entry = (r.GetBool("is_unique"), r.GetBool("is_primary"), new List<string>());
                byName[name] = entry;
            }
            entry.Cols.Add(r.GetString("column_name")!);
            // re-store the tuple since we mutated the List inside it (tuple value-copy)
            byName[name] = entry;
        }
        return byName
            .Where(kv => !kv.Value.IsPrimary) // PK is carried separately on TableDescriptor
            .Select(kv => new IndexDescriptor(kv.Key, kv.Value.Cols, kv.Value.IsUnique))
            .ToList();
    }

    private static async Task<List<FkDescriptor>> ReadForeignKeysAsync(IPgIntrospector db, string schema, string table)
    {
        var rows = await db.QueryAsync(ForeignKeysSql, ("schema", schema), ("table", table));
        var byName = new Dictionary<string, (string RefTable, List<string> Cols, List<string> RefCols, FkAction? OnDelete, FkAction? OnUpdate)>(StringComparer.Ordinal);
        foreach (var r in rows)
        {
            var name = r.GetString("fk_name")!;
            if (!byName.TryGetValue(name, out var entry))
            {
                entry = (
                    r.GetString("ref_table")!,
                    new List<string>(),
                    new List<string>(),
                    PgRuleToAction(r.GetString("delete_rule") ?? ""),
                    PgRuleToAction(r.GetString("update_rule") ?? ""));
                byName[name] = entry;
            }
            entry.Cols.Add(r.GetString("column_name")!);
            entry.RefCols.Add(r.GetString("ref_column")!);
            byName[name] = entry;
        }
        return byName
            .Select(kv => new FkDescriptor(
                Name: kv.Key,
                Columns: kv.Value.Cols,
                RefTable: kv.Value.RefTable,
                RefColumns: kv.Value.RefCols,
                OnDelete: kv.Value.OnDelete,
                OnUpdate: kv.Value.OnUpdate))
            .ToList();
    }
}
