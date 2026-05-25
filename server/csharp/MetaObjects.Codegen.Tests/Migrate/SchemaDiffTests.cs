using MetaObjects.Codegen.Migrate;
using Xunit;

namespace MetaObjects.Codegen.Tests.Migrate;

public class SchemaDiffTests
{
    private static ColumnDescriptor Col(string name, SqlType type, bool nullable = true,
        ColumnDefault? def = null, IdentityKind? identity = null) =>
        new(name, type, nullable, def, identity);

    private static TableDescriptor Table(string name, IReadOnlyList<ColumnDescriptor> cols,
        IReadOnlyList<string>? pk = null, IReadOnlyList<IndexDescriptor>? idx = null,
        IReadOnlyList<FkDescriptor>? fks = null, string? schema = null) =>
        new(name, cols, idx ?? [], fks ?? [], pk ?? [], schema);

    private static SchemaSnapshot Snap(params TableDescriptor[] tables) => new(tables);
    private static readonly SchemaSnapshot Empty = new([]);

    [Fact]
    public void New_table_emits_create_plus_indexes_and_fks()
    {
        var t = Table("posts",
            [Col("id", new SqlType.Integer(64), nullable: false), Col("authorId", new SqlType.Integer(64), nullable: false)],
            pk: ["id"],
            idx: [new IndexDescriptor("posts_author_idx", ["authorId"], false)],
            fks: [new FkDescriptor("posts_authorId_fk", ["authorId"], "authors", ["id"])]);

        var result = SchemaDiff.Diff(Snap(t), Empty);

        Assert.Collection(result.Changes,
            c => Assert.IsType<Change.CreateTable>(c),
            c => Assert.IsType<Change.AddIndex>(c),
            c => Assert.IsType<Change.AddFk>(c));
        Assert.Empty(result.Blocked);
    }

    [Fact]
    public void Dropped_table_blocked_unless_allowed()
    {
        var actual = Snap(Table("legacy", [Col("id", new SqlType.Integer(64))], pk: ["id"]));

        var blocked = SchemaDiff.Diff(Empty, actual);
        var drop = Assert.IsType<Change.DropTable>(Assert.Single(blocked.Changes));
        Assert.False(drop.Status.Allowed);
        Assert.Single(blocked.Blocked);

        var allowed = SchemaDiff.Diff(Empty, actual, new AllowOptions(DropTable: true));
        Assert.True(allowed.Changes.Single().Status.Allowed);
    }

    [Fact]
    public void Added_column_is_allowed()
    {
        var expected = Snap(Table("t", [Col("id", new SqlType.Integer(64)), Col("email", new SqlType.Text(255))]));
        var actual = Snap(Table("t", [Col("id", new SqlType.Integer(64))]));

        var add = Assert.IsType<Change.AddColumn>(Assert.Single(SchemaDiff.Diff(expected, actual).Changes));
        Assert.Equal("email", add.Column.Name);
        Assert.True(add.Status.Allowed);
    }

    [Fact]
    public void Dropped_column_blocked_unless_allowed()
    {
        var expected = Snap(Table("t", [Col("id", new SqlType.Integer(64))]));
        var actual = Snap(Table("t", [Col("id", new SqlType.Integer(64)), Col("stale", new SqlType.Text())]));

        Assert.False(SchemaDiff.Diff(expected, actual).Changes.Single().Status.Allowed);
        Assert.True(SchemaDiff.Diff(expected, actual, new AllowOptions(DropColumn: true)).Changes.Single().Status.Allowed);
    }

    [Fact]
    public void Type_change_widening_allowed_narrowing_blocked()
    {
        var widen = SchemaDiff.Diff(
            Snap(Table("t", [Col("n", new SqlType.Integer(64))])),
            Snap(Table("t", [Col("n", new SqlType.Integer(32))])));
        var wc = Assert.IsType<Change.ChangeColumnType>(Assert.Single(widen.Changes));
        Assert.True(wc.Status.Allowed);
        Assert.Equal(new SqlType.Integer(32), wc.From);
        Assert.Equal(new SqlType.Integer(64), wc.To);

        var narrow = SchemaDiff.Diff(
            Snap(Table("t", [Col("n", new SqlType.Integer(32))])),
            Snap(Table("t", [Col("n", new SqlType.Integer(64))])));
        Assert.False(narrow.Changes.Single().Status.Allowed);
        Assert.True(SchemaDiff.Diff(
            Snap(Table("t", [Col("n", new SqlType.Integer(32))])),
            Snap(Table("t", [Col("n", new SqlType.Integer(64))])),
            new AllowOptions(TypeChange: true)).Changes.Single().Status.Allowed);
    }

    [Fact]
    public void Nullable_transitions_classified()
    {
        // notnull (actual) -> nullable (expected): allowed.
        var relax = SchemaDiff.Diff(
            Snap(Table("t", [Col("c", new SqlType.Text(), nullable: true)])),
            Snap(Table("t", [Col("c", new SqlType.Text(), nullable: false)])));
        var rc = Assert.IsType<Change.ChangeColumnNullable>(Assert.Single(relax.Changes));
        Assert.True(rc.Status.Allowed);
        Assert.False(rc.From);
        Assert.True(rc.To);

        // nullable (actual) -> notnull (expected): blocked unless allowed.
        var tighten = SchemaDiff.Diff(
            Snap(Table("t", [Col("c", new SqlType.Text(), nullable: false)])),
            Snap(Table("t", [Col("c", new SqlType.Text(), nullable: true)])));
        Assert.False(tighten.Changes.Single().Status.Allowed);
        Assert.True(SchemaDiff.Diff(
            Snap(Table("t", [Col("c", new SqlType.Text(), nullable: false)])),
            Snap(Table("t", [Col("c", new SqlType.Text(), nullable: true)])),
            new AllowOptions(NullableToNotNull: true)).Changes.Single().Status.Allowed);
    }

    [Fact]
    public void Default_change_detected()
    {
        var expected = Snap(Table("t", [Col("c", new SqlType.Integer(32), def: new ColumnDefault(DefaultKind.Literal, "0"))]));
        var actual = Snap(Table("t", [Col("c", new SqlType.Integer(32))]));
        var ch = Assert.IsType<Change.ChangeColumnDefault>(Assert.Single(SchemaDiff.Diff(expected, actual).Changes));
        Assert.Null(ch.From);
        Assert.Equal(new ColumnDefault(DefaultKind.Literal, "0"), ch.To);
    }

    [Fact]
    public void Identity_attach_and_detach_emit_change_column_identity()
    {
        // Identity attach: actual column has none, expected is increment.
        var attach = SchemaDiff.Diff(
            Snap(Table("t", [Col("id", new SqlType.Integer(64), nullable: false, identity: IdentityKind.Increment)])),
            Snap(Table("t", [Col("id", new SqlType.Integer(64), nullable: false)])));
        var add = Assert.IsType<Change.ChangeColumnIdentity>(Assert.Single(attach.Changes));
        Assert.Null(add.From);
        Assert.Equal(IdentityKind.Increment, add.To);
        Assert.True(add.Status.Allowed);

        // Identity detach: reverse direction.
        var detach = SchemaDiff.Diff(
            Snap(Table("t", [Col("id", new SqlType.Integer(64), nullable: false)])),
            Snap(Table("t", [Col("id", new SqlType.Integer(64), nullable: false, identity: IdentityKind.Increment)])));
        var drop = Assert.IsType<Change.ChangeColumnIdentity>(Assert.Single(detach.Changes));
        Assert.Equal(IdentityKind.Increment, drop.From);
        Assert.Null(drop.To);

        // No change when both sides agree.
        var same = SchemaDiff.Diff(
            Snap(Table("t", [Col("id", new SqlType.Integer(64), nullable: false, identity: IdentityKind.Increment)])),
            Snap(Table("t", [Col("id", new SqlType.Integer(64), nullable: false, identity: IdentityKind.Increment)])));
        Assert.Empty(same.Changes);
    }

    [Fact]
    public void Index_shape_change_emits_drop_then_add()
    {
        var expected = Snap(Table("t", [Col("a", new SqlType.Text())], idx: [new IndexDescriptor("ix", ["a"], true)]));
        var actual = Snap(Table("t", [Col("a", new SqlType.Text())], idx: [new IndexDescriptor("ix", ["a"], false)]));
        var changes = SchemaDiff.Diff(expected, actual, new AllowOptions(DropIndex: true)).Changes;
        Assert.Collection(changes,
            c => Assert.IsType<Change.DropIndex>(c),
            c => Assert.IsType<Change.AddIndex>(c));
    }

    [Fact]
    public void Fk_change_emits_drop_then_add()
    {
        var expected = Snap(Table("t", [Col("x", new SqlType.Integer(64))],
            fks: [new FkDescriptor("fk", ["x"], "other", ["id"], OnDelete: FkAction.Cascade)]));
        var actual = Snap(Table("t", [Col("x", new SqlType.Integer(64))],
            fks: [new FkDescriptor("fk", ["x"], "other", ["id"])]));
        var changes = SchemaDiff.Diff(expected, actual, new AllowOptions(DropFk: true)).Changes;
        Assert.Collection(changes,
            c => Assert.IsType<Change.DropFk>(c),
            c => Assert.IsType<Change.AddFk>(c));
    }

    [Fact]
    public void Identical_snapshots_produce_no_changes()
    {
        var t = Table("t", [Col("id", new SqlType.Integer(64), nullable: false)], pk: ["id"],
            idx: [new IndexDescriptor("ix", ["id"], true)],
            fks: [new FkDescriptor("fk", ["id"], "o", ["id"])]);
        Assert.Empty(SchemaDiff.Diff(Snap(t), Snap(t)).Changes);
    }

    [Fact]
    public void Ignored_tables_are_excluded_from_both_sides()
    {
        var expected = Snap(Table("posts", [Col("id", new SqlType.Integer(64))]));
        var actual = Snap(Table("__EFMigrationsHistory", [Col("MigrationId", new SqlType.Text())]));
        var changes = SchemaDiff.Diff(expected, actual, ignoreTables: ["__EFMigrationsHistory", "_litestream_*"]).Changes;
        // Only the create-table for posts; the history table is neither created nor dropped.
        Assert.IsType<Change.CreateTable>(Assert.Single(changes));
    }
}
