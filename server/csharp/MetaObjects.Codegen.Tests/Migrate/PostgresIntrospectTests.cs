using MetaObjects.Codegen.Migrate;
using Xunit;

namespace MetaObjects.Codegen.Tests.Migrate;

public class PostgresIntrospectTests
{
    // Information_schema.columns row shaped like the production ReadColumnsAsync
    // query expects. Keeps every field visible at the call-site via named args.
    // Defaults mirror the most common "plain bigint NOT NULL with no default,
    // not an identity" shape so unrelated tests don't have to repeat seven nulls.
    private static PgRow ColRow(
        string columnName,
        string dataType = "bigint",
        string udtName = "int8",
        long? maxLength = null,
        string isNullable = "NO",
        string? columnDefault = null,
        string isIdentity = "NO") =>
        PgRow.Of(
            ("column_name", columnName),
            ("data_type", dataType),
            ("udt_name", udtName),
            ("character_maximum_length", maxLength),
            ("is_nullable", isNullable),
            ("column_default", columnDefault),
            ("is_identity", isIdentity));

    // -----------------------------------------------------------------------
    // PgTypeToSqlType — pure string → canonical SqlType
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("character varying(255)", null, 255)]
    [InlineData("VARCHAR(120)", null, 120)]                  // case-insensitive
    [InlineData("character varying", 80L, 80)]               // bare form + maxLength supplies the bound
    public void PgTypeToSqlType_text_bounded(string dataType, long? maxLen, long expected)
    {
        var t = PostgresIntrospect.PgTypeToSqlType(dataType, maxLen);
        Assert.Equal(new SqlType.Text(expected), t);
    }

    [Theory]
    [InlineData("text")]
    [InlineData("character varying")]                        // bare, no maxLength → unbounded
    public void PgTypeToSqlType_text_unbounded(string dataType)
    {
        Assert.Equal(new SqlType.Text(), PostgresIntrospect.PgTypeToSqlType(dataType));
    }

    [Theory]
    [InlineData("bigint", 64)]
    [InlineData("int8", 64)]
    [InlineData("bigserial", 64)]
    [InlineData("integer", 32)]
    [InlineData("int4", 32)]
    [InlineData("serial", 32)]
    [InlineData("smallint", 32)]                              // smallint widens to Integer(32) in the canonical model
    [InlineData("smallserial", 32)]
    public void PgTypeToSqlType_integers(string dataType, int bits)
    {
        Assert.Equal(new SqlType.Integer(bits), PostgresIntrospect.PgTypeToSqlType(dataType));
    }

    [Theory]
    [InlineData("real")]
    [InlineData("float4")]
    [InlineData("double precision")]
    [InlineData("float8")]
    public void PgTypeToSqlType_real(string dataType)
    {
        Assert.Equal(new SqlType.Real(), PostgresIntrospect.PgTypeToSqlType(dataType));
    }

    [Fact]
    public void PgTypeToSqlType_numeric_with_precision_and_scale()
    {
        Assert.Equal(new SqlType.Numeric(10, 2), PostgresIntrospect.PgTypeToSqlType("numeric(10,2)"));
        Assert.Equal(new SqlType.Numeric(10, 2), PostgresIntrospect.PgTypeToSqlType("decimal(10, 2)")); // alias + space tolerated
        Assert.Equal(new SqlType.Numeric(8, null), PostgresIntrospect.PgTypeToSqlType("numeric(8)"));
        Assert.Equal(new SqlType.Numeric(null, null), PostgresIntrospect.PgTypeToSqlType("numeric"));
    }

    [Theory]
    [InlineData("timestamp", false)]
    [InlineData("timestamp without time zone", false)]
    [InlineData("timestamptz", true)]
    [InlineData("timestamp with time zone", true)]
    public void PgTypeToSqlType_timestamps(string dataType, bool withTz)
    {
        Assert.Equal(new SqlType.Timestamp(withTz), PostgresIntrospect.PgTypeToSqlType(dataType));
    }

    [Theory]
    [InlineData("boolean", typeof(SqlType.Boolean))]
    [InlineData("bool", typeof(SqlType.Boolean))]
    [InlineData("date", typeof(SqlType.Date))]
    [InlineData("json", typeof(SqlType.Json))]
    [InlineData("jsonb", typeof(SqlType.Json))]
    [InlineData("bytea", typeof(SqlType.Blob))]
    [InlineData("uuid", typeof(SqlType.Uuid))]
    [InlineData("citext", typeof(SqlType.Text))]              // unknown → text fallback
    [InlineData("user_defined_enum", typeof(SqlType.Text))]
    public void PgTypeToSqlType_scalar_and_fallback(string dataType, Type expected)
    {
        Assert.IsType(expected, PostgresIntrospect.PgTypeToSqlType(dataType));
    }

    // -----------------------------------------------------------------------
    // ParsePgDefault — string → ColumnDefault?
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("now()")]
    [InlineData("CURRENT_TIMESTAMP")]
    [InlineData("current_date")]
    [InlineData("nextval('public.posts_id_seq'::regclass)")]
    [InlineData("NULL::text")]                                // anything with :: but not starting with ' is an expr
    [InlineData("ARRAY[]::text[]")]
    public void ParsePgDefault_expressions(string raw)
    {
        var d = PostgresIntrospect.ParsePgDefault(raw);
        Assert.NotNull(d);
        Assert.Equal(DefaultKind.Expr, d!.Kind);
        Assert.Equal(raw, d.Value);
    }

    [Theory]
    [InlineData("'hello'::text", "hello")]
    [InlineData("'hello'", "hello")]
    [InlineData("'42'::integer", "42")]
    [InlineData("'true'::boolean", "true")]
    public void ParsePgDefault_literal_strips_cast_and_quotes(string raw, string expected)
    {
        var d = PostgresIntrospect.ParsePgDefault(raw);
        Assert.NotNull(d);
        Assert.Equal(DefaultKind.Literal, d!.Kind);
        Assert.Equal(expected, d.Value);
    }

    [Fact]
    public void ParsePgDefault_bare_value_is_literal()
    {
        var d = PostgresIntrospect.ParsePgDefault("42");
        Assert.Equal(new ColumnDefault(DefaultKind.Literal, "42"), d);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void ParsePgDefault_absent_returns_null(string? raw) =>
        Assert.Null(PostgresIntrospect.ParsePgDefault(raw));

    // -----------------------------------------------------------------------
    // PgRuleToAction — referential action wire string → FkAction?
    // -----------------------------------------------------------------------

    [Theory]
    [InlineData("CASCADE", FkAction.Cascade)]
    [InlineData("cascade", FkAction.Cascade)]
    [InlineData("SET NULL", FkAction.SetNull)]
    [InlineData("RESTRICT", FkAction.Restrict)]
    public void PgRuleToAction_translates(string rule, FkAction expected) =>
        Assert.Equal(expected, PostgresIntrospect.PgRuleToAction(rule));

    [Theory]
    [InlineData("NO ACTION")]
    [InlineData("no action")]
    [InlineData("")]
    [InlineData("UNKNOWN")]
    public void PgRuleToAction_returns_null_for_no_action_or_unknown(string rule) =>
        Assert.Null(PostgresIntrospect.PgRuleToAction(rule));

    // -----------------------------------------------------------------------
    // IntrospectAsync — orchestrator against a fake row reader
    // -----------------------------------------------------------------------

    [Fact]
    public async Task Empty_database_produces_empty_snapshot()
    {
        var fake = new FakePgIntrospector();
        var snap = await PostgresIntrospect.IntrospectAsync(fake);
        Assert.Empty(snap.Tables);
    }

    [Fact]
    public async Task Single_table_with_columns_pk_index_and_fk_round_trips()
    {
        var fake = new FakePgIntrospector();
        // 1) tables
        fake.OnTables(("public", "posts"));
        // 2) columns (id pk via nextval, title varchar(200) NOT NULL, score numeric(10,2) NULL, body text NULL DEFAULT 'x')
        fake.OnColumns("public", "posts",
            ColRow("id", columnDefault: "nextval('public.posts_id_seq'::regclass)"),
            ColRow("title", dataType: "character varying", udtName: "varchar", maxLength: 200L),
            ColRow("score", dataType: "numeric(10,2)", udtName: "numeric", isNullable: "YES"),
            ColRow("body", dataType: "text", udtName: "text", isNullable: "YES", columnDefault: "'x'::text"));
        // 3) PK
        fake.OnPrimaryKey("public", "posts", "id");
        // 4) indexes (the PK index appears here too — orchestrator must drop is_primary=true)
        fake.OnIndexes("public", "posts",
            PgRow.Of(("index_name", "posts_pkey"), ("is_unique", true), ("is_primary", true),
                     ("column_name", "id"), ("ordinal", 1)),
            PgRow.Of(("index_name", "posts_title_uniq"), ("is_unique", true), ("is_primary", false),
                     ("column_name", "title"), ("ordinal", 1)));
        // 5) FK
        fake.OnForeignKeys("public", "posts",
            PgRow.Of(("fk_name", "posts_author_fk"), ("column_name", "author_id"),
                     ("ref_table", "authors"), ("ref_column", "id"),
                     ("update_rule", "NO ACTION"), ("delete_rule", "CASCADE"), ("ordinal", 1)));

        var snap = await PostgresIntrospect.IntrospectAsync(fake);
        var t = Assert.Single(snap.Tables);

        Assert.Equal("posts", t.Name);
        Assert.Null(t.Schema); // public is normalized to null
        Assert.Equal(["id"], t.PrimaryKey.ToArray());

        // Columns
        var id = t.Columns.Single(c => c.Name == "id");
        Assert.Equal(new SqlType.Integer(64), id.SqlType);
        Assert.False(id.Nullable);
        Assert.Equal(IdentityKind.Increment, id.Identity); // nextval → identity=increment
        var title = t.Columns.Single(c => c.Name == "title");
        Assert.Equal(new SqlType.Text(200), title.SqlType);
        Assert.False(title.Nullable);
        var score = t.Columns.Single(c => c.Name == "score");
        Assert.Equal(new SqlType.Numeric(10, 2), score.SqlType);
        Assert.True(score.Nullable);
        var body = t.Columns.Single(c => c.Name == "body");
        Assert.Equal(new ColumnDefault(DefaultKind.Literal, "x"), body.Default);

        // Indexes — PK index suppressed; secondary unique index kept.
        var idx = Assert.Single(t.Indexes);
        Assert.Equal("posts_title_uniq", idx.Name);
        Assert.True(idx.Unique);

        // FKs — NO ACTION becomes null (omitted clause); CASCADE survives.
        var fk = Assert.Single(t.ForeignKeys);
        Assert.Equal("posts_author_fk", fk.Name);
        Assert.Equal("authors", fk.RefTable);
        Assert.Equal(["author_id"], fk.Columns.ToArray());
        Assert.Equal(["id"], fk.RefColumns.ToArray());
        Assert.Equal(FkAction.Cascade, fk.OnDelete);
        Assert.Null(fk.OnUpdate);
    }

    [Fact]
    public async Task Non_public_schema_is_preserved()
    {
        var fake = new FakePgIntrospector();
        fake.OnTables(("billing", "invoices"));
        fake.OnColumns("billing", "invoices", ColRow("id"));
        fake.OnPrimaryKey("billing", "invoices", "id");

        var t = Assert.Single((await PostgresIntrospect.IntrospectAsync(fake)).Tables);
        Assert.Equal("billing", t.Schema);
    }

    [Fact]
    public async Task Composite_pk_preserves_ordinal_order()
    {
        var fake = new FakePgIntrospector();
        fake.OnTables(("public", "links"));
        fake.OnColumns("public", "links", ColRow("a"), ColRow("b"));
        fake.OnPrimaryKey("public", "links", "b", "a"); // order matters

        var t = Assert.Single((await PostgresIntrospect.IntrospectAsync(fake)).Tables);
        Assert.Equal(["b", "a"], t.PrimaryKey.ToArray());
    }

    [Fact]
    public async Task Composite_fk_preserves_column_pairing()
    {
        var fake = new FakePgIntrospector();
        fake.OnTables(("public", "child"));
        fake.OnColumns("public", "child", ColRow("p_a"), ColRow("p_b"));
        fake.OnForeignKeys("public", "child",
            PgRow.Of(("fk_name", "child_parent_fk"), ("column_name", "p_a"),
                     ("ref_table", "parent"), ("ref_column", "a"),
                     ("update_rule", "RESTRICT"), ("delete_rule", "CASCADE"), ("ordinal", 1)),
            PgRow.Of(("fk_name", "child_parent_fk"), ("column_name", "p_b"),
                     ("ref_table", "parent"), ("ref_column", "b"),
                     ("update_rule", "RESTRICT"), ("delete_rule", "CASCADE"), ("ordinal", 2)));

        var t = Assert.Single((await PostgresIntrospect.IntrospectAsync(fake)).Tables);
        var fk = Assert.Single(t.ForeignKeys);
        Assert.Equal(["p_a", "p_b"], fk.Columns.ToArray());
        Assert.Equal(["a", "b"], fk.RefColumns.ToArray());
        Assert.Equal(FkAction.Cascade, fk.OnDelete);
        Assert.Equal(FkAction.Restrict, fk.OnUpdate);
    }

    [Fact]
    public async Task Non_unique_and_multi_column_indexes_are_carried()
    {
        var fake = new FakePgIntrospector();
        fake.OnTables(("public", "t"));
        fake.OnColumns("public", "t", ColRow("x"));
        fake.OnIndexes("public", "t",
            // Non-unique single-column.
            PgRow.Of(("index_name", "t_x_idx"), ("is_unique", false), ("is_primary", false),
                     ("column_name", "x"), ("ordinal", 1)),
            // Multi-column unique — rows arrive ordered by `ordinal` from the SQL's ORDER BY.
            PgRow.Of(("index_name", "t_ab_uq"), ("is_unique", true), ("is_primary", false),
                     ("column_name", "a"), ("ordinal", 1)),
            PgRow.Of(("index_name", "t_ab_uq"), ("is_unique", true), ("is_primary", false),
                     ("column_name", "b"), ("ordinal", 2)));

        var t = Assert.Single((await PostgresIntrospect.IntrospectAsync(fake)).Tables);
        var idx = t.Indexes.Single(i => i.Name == "t_x_idx");
        Assert.False(idx.Unique);
        Assert.Equal(["x"], idx.Columns.ToArray());
        var uq = t.Indexes.Single(i => i.Name == "t_ab_uq");
        Assert.True(uq.Unique);
        Assert.Equal(["a", "b"], uq.Columns.ToArray());
    }

    [Fact]
    public async Task Serial_detected_via_udt_name_when_default_is_absent()
    {
        // Belt-and-suspenders: covers the udt_name-only branch (a serial column whose
        // sequence default has been stripped or unmapped). The PG10+ identity branch
        // (is_identity=YES) is covered by the next test.
        var fake = new FakePgIntrospector();
        fake.OnTables(("public", "t"));
        fake.OnColumns("public", "t", ColRow("id", udtName: "bigserial"));

        var t = Assert.Single((await PostgresIntrospect.IntrospectAsync(fake)).Tables);
        var id = Assert.Single(t.Columns);
        Assert.Equal(IdentityKind.Increment, id.Identity);
        Assert.Null(id.Default);
    }

    [Fact]
    public async Task Pg10_identity_column_detected_via_is_identity()
    {
        // PG 10+ GENERATED ... AS IDENTITY columns surface as is_identity='YES' with
        // no nextval(...) default. Must still mark the column identity=increment.
        var fake = new FakePgIntrospector();
        fake.OnTables(("public", "t"));
        fake.OnColumns("public", "t", ColRow("id", isIdentity: "YES"));

        var t = Assert.Single((await PostgresIntrospect.IntrospectAsync(fake)).Tables);
        var id = Assert.Single(t.Columns);
        Assert.Equal(IdentityKind.Increment, id.Identity);
    }

    [Fact]
    public async Task Snapshot_round_trips_through_diff_against_expected()
    {
        // The whole point of introspection: the snapshot it produces compares cleanly
        // against an ExpectedSchema-built snapshot. Construct one of each by hand and
        // confirm SchemaDiff finds no changes.
        var fake = new FakePgIntrospector();
        fake.OnTables(("public", "t"));
        fake.OnColumns("public", "t", ColRow("id", columnDefault: "nextval('t_id_seq'::regclass)"));
        fake.OnPrimaryKey("public", "t", "id");

        var actual = await PostgresIntrospect.IntrospectAsync(fake);
        var expected = new SchemaSnapshot([new TableDescriptor(
            Name: "t",
            Columns: [new ColumnDescriptor("id", new SqlType.Integer(64), Nullable: false, Identity: IdentityKind.Increment)],
            Indexes: [], ForeignKeys: [], PrimaryKey: ["id"])]);

        var diff = SchemaDiff.Diff(expected, actual);
        Assert.Empty(diff.Changes);
    }
}

// -----------------------------------------------------------------------
// Fake row reader for testing the orchestrator without a live DB.
// Matches queries by a substring of their SQL (each helper query has a
// unique anchor — table_constraints, pg_index, etc.).
// -----------------------------------------------------------------------

internal sealed class FakePgIntrospector : IPgIntrospector
{
    private readonly List<(Func<string, (string Name, object? Value)[], bool> Match, IReadOnlyList<PgRow> Rows)> _routes = new();

    public void OnTables(params (string Schema, string Name)[] tables)
    {
        var rows = tables.Select(t => PgRow.Of(("table_schema", t.Schema), ("table_name", t.Name))).ToList();
        _routes.Add(((sql, _) => sql.Contains("information_schema.tables"), rows));
    }

    public void OnColumns(string schema, string table, params PgRow[] rows) =>
        _routes.Add(((sql, p) =>
            sql.Contains("information_schema.columns")
                && p.Any(x => x is { Name: "schema" } && Equals(x.Value, schema))
                && p.Any(x => x is { Name: "table" } && Equals(x.Value, table)),
            rows));

    public void OnPrimaryKey(string schema, string table, params string[] cols) =>
        _routes.Add(((sql, p) =>
            // Match the constraint_type literal anchor — narrower than "PRIMARY KEY"
            // alone so a future SQL comment can't accidentally collide.
            sql.Contains("'PRIMARY KEY'")
                && p.Any(x => x is { Name: "schema" } && Equals(x.Value, schema))
                && p.Any(x => x is { Name: "table" } && Equals(x.Value, table)),
            cols.Select((c, i) => PgRow.Of(("column_name", c), ("ordinal_position", (long)(i + 1)))).ToList()));

    public void OnIndexes(string schema, string table, params PgRow[] rows) =>
        _routes.Add(((sql, p) =>
            sql.Contains("pg_index")
                && p.Any(x => x is { Name: "schema" } && Equals(x.Value, schema))
                && p.Any(x => x is { Name: "table" } && Equals(x.Value, table)),
            rows));

    public void OnForeignKeys(string schema, string table, params PgRow[] rows) =>
        _routes.Add(((sql, p) =>
            sql.Contains("referential_constraints")
                && p.Any(x => x is { Name: "schema" } && Equals(x.Value, schema))
                && p.Any(x => x is { Name: "table" } && Equals(x.Value, table)),
            rows));

    public Task<IReadOnlyList<PgRow>> QueryAsync(string sql, params (string Name, object? Value)[] parameters)
    {
        foreach (var route in _routes)
            if (route.Match(sql, parameters)) return Task.FromResult(route.Rows);
        return Task.FromResult<IReadOnlyList<PgRow>>([]);
    }
}
