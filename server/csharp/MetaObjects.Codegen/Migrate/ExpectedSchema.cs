// ExpectedSchema — builds a SchemaSnapshot from a loaded MetaRoot (metadata).
// Bridges the source-v2 metadata layer to the migration engine: SchemaDiff
// compares this against an introspected snapshot, PostgresEmit renders the diff.
//
// Ported from typescript/packages/migrate-ts/src/expected-schema.ts, adapted to
// source-v2 (ADR-0007): the primary writable source.rdb supplies @table + @schema;
// fields use @column; identity.reference @enforce gates FK emission; relationship
// @onDelete/@onUpdate (per-subtype defaults) populate FkDescriptor actions via
// ReferentialActions.Resolve.
//
// Pure value objects, abstract bases, and read-only projections (no primary
// writable source) are excluded; views are deferred (v0.1 of the engine snapshots
// tables only). Identifier conventions match PostgresEmit (the canonical engine
// target) — quoted idents and {table}_pkey come from the emit layer; this builder
// emits bare logical names (unique-index name = identity.name; FK name = built
// from columns).

using MetaObjects.Codegen.Schema;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Identity.IdentityConstants;

namespace MetaObjects.Codegen.Migrate;

/// <summary>Builds a SchemaSnapshot from metadata (the "expected" side of the diff).</summary>
public static class ExpectedSchema
{
    /// <summary>
    /// Produces the snapshot the live DB should match: one TableDescriptor per
    /// writable entity (entities with a primary writable source.rdb), ordered by
    /// metadata object name.
    /// </summary>
    public static SchemaSnapshot Build(MetaRoot root)
    {
        var tables = root.Objects()
            .Where(o => o.IsEntity() && o.FindPrimaryWritableSource() is not null)
            .OrderBy(o => o.Name, StringComparer.Ordinal)
            .Select(o => BuildTable(o, root))
            .ToList();
        return new SchemaSnapshot(tables);
    }

    private static TableDescriptor BuildTable(MetaObject entity, MetaRoot root)
    {
        var source = entity.FindPrimaryWritableSource()!;
        var tableName = source.TableName ?? entity.Name;
        var schema = source.Schema;
        var pk = entity.PrimaryIdentity();
        var pkFieldNames = pk?.Fields ?? [];
        var pkSet = pkFieldNames.ToHashSet(StringComparer.Ordinal);
        var pkGeneration = (pk as MetaPrimaryIdentity)?.Generation;

        var columns = BuildColumns(entity, root, pkSet, pkGeneration).ToList();
        var primaryKey = pkFieldNames.Select(n => ResolveColumn(entity, n)).ToList();
        var indexes = BuildIndexes(entity).ToList();
        var foreignKeys = BuildForeignKeys(entity, root).ToList();

        return new TableDescriptor(tableName, columns, indexes, foreignKeys, primaryKey, schema);
    }

    // Columns in declared order: scalar → one ColumnDescriptor; object @storage
    // flattened → expand each nested scalar as "{parentCol}_{nestedCol}" (parent
    // contributes no column); other object storage → a single json column.
    private static IEnumerable<ColumnDescriptor> BuildColumns(
        MetaObject entity, MetaRoot root,
        IReadOnlySet<string> pkSet, string? pkGeneration)
    {
        foreach (var f in entity.Fields())
        {
            if (CSharpNaming.ScalarFor(f.SubType) is not null)
            {
                var isPk = pkSet.Contains(f.Name);
                yield return BuildColumn(entity, f, isPk, isPk ? pkGeneration : null);
            }
            else if (f.SubType == FIELD_SUBTYPE_OBJECT)
            {
                foreach (var c in ObjectFieldColumns(entity, f, root)) yield return c;
            }
        }
    }

    private static IEnumerable<ColumnDescriptor> ObjectFieldColumns(
        MetaObject entity, MetaField f, MetaRoot root)
    {
        if (f.Storage == STORAGE_FLATTENED && f.ObjectRef is { } oref &&
            root.FindObject(CSharpNaming.StripPkg(oref)) is { } nested)
        {
            var prefix = CSharpNaming.Column(f) + "_";
            foreach (var nf in nested.Fields().Where(n => CSharpNaming.ScalarFor(n.SubType) is not null))
            {
                var inner = BuildColumn(nested, nf, isPk: false, pkGeneration: null);
                yield return inner with { Name = prefix + inner.Name };
            }
            yield break;
        }
        yield return new ColumnDescriptor(
            CSharpNaming.Column(f),
            new SqlType.Json(),
            Nullable: !CSharpNaming.IsRequired(entity, f));
    }

    private static ColumnDescriptor BuildColumn(
        MetaObject owner, MetaField field, bool isPk, string? pkGeneration)
    {
        var sqlType = SubtypeToSqlType(field);
        var required = CSharpNaming.IsRequired(owner, field);
        // PK columns are NOT NULL by definition (and their own @required is implicit).
        var nullable = !isPk && !required;
        var identity = isPk ? ToIdentityKind(pkGeneration) : null;
        var def = BuildDefault(field);
        return new ColumnDescriptor(CSharpNaming.Column(field), sqlType, nullable, def, identity);
    }

    // Canonical, dialect-neutral type from the field subtype + sizing attrs.
    // time → text intentionally (SqlType has no Time variant — see SqlType.cs);
    // object falls through to json (the flattened path is handled above and bypasses this).
    private static SqlType SubtypeToSqlType(MetaField f) => f.SubType switch
    {
        FIELD_SUBTYPE_STRING or FIELD_SUBTYPE_CLASS => new SqlType.Text(f.MaxLength),
        FIELD_SUBTYPE_INT or FIELD_SUBTYPE_SHORT or FIELD_SUBTYPE_BYTE => new SqlType.Integer(32),
        FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_CURRENCY => new SqlType.Integer(64),
        FIELD_SUBTYPE_DOUBLE or FIELD_SUBTYPE_FLOAT => new SqlType.Real(),
        FIELD_SUBTYPE_DECIMAL => new SqlType.Numeric(f.Precision, f.Scale),
        FIELD_SUBTYPE_BOOLEAN => new SqlType.Boolean(),
        FIELD_SUBTYPE_DATE => new SqlType.Date(),
        FIELD_SUBTYPE_TIME => new SqlType.Text(),
        FIELD_SUBTYPE_TIMESTAMP => new SqlType.Timestamp(WithTimezone: false),
        FIELD_SUBTYPE_OBJECT => new SqlType.Json(),
        _ => new SqlType.Text(),
    };

    private static IdentityKind? ToIdentityKind(string? generation) => generation switch
    {
        GENERATION_INCREMENT => IdentityKind.Increment,
        GENERATION_UUID => IdentityKind.Uuid,
        _ => null,
    };

    // Recognize common SQL expressions; everything else is treated as a literal so
    // the emit layer can quote it. Mirrors TS expected-schema.ts EXPR_DEFAULT_PATTERNS.
    private static ColumnDefault? BuildDefault(MetaField f)
    {
        if (f.Default is not { } raw) return null;
        if (raw is string s && s.Length > 0)
        {
            return IsExpressionLiteral(s)
                ? new ColumnDefault(DefaultKind.Expr, s)
                : new ColumnDefault(DefaultKind.Literal, s);
        }
        if (raw is bool b) return new ColumnDefault(DefaultKind.Literal, b ? "true" : "false");
        if (raw is IFormattable n) return new ColumnDefault(DefaultKind.Literal, n.ToString(null, System.Globalization.CultureInfo.InvariantCulture));
        return null;
    }

    private static bool IsExpressionLiteral(string s)
    {
        // Common Postgres / ANSI date-time keywords + any function call (parens).
        if (s.Contains('('))                                                 return true;
        return string.Equals(s, "current_timestamp", StringComparison.OrdinalIgnoreCase)
            || string.Equals(s, "current_date",      StringComparison.OrdinalIgnoreCase)
            || string.Equals(s, "current_time",      StringComparison.OrdinalIgnoreCase);
    }

    // Unique indexes come from secondary identities (unique unless @unique:false).
    // Index NAME = bare identity name (matches TS expected-schema.ts:204; diverges
    // from PostgresSchema's "{table}_{name}_uniq" — reconciliation tracked separately).
    private static IEnumerable<IndexDescriptor> BuildIndexes(MetaObject entity)
    {
        foreach (var sec in entity.SecondaryIdentities())
        {
            var cols = sec.Fields.Select(n => ResolveColumn(entity, n)).ToList();
            yield return new IndexDescriptor(sec.Name, cols, sec.Unique);
        }
    }

    // FK constraints come from enforced reference identities. Action threading
    // (ON DELETE / ON UPDATE) goes through ReferentialActions.Resolve, which pairs
    // the FK to the matching relationship by @objectRef and reads its effective
    // referential actions (explicit attr → per-subtype default).
    private static IEnumerable<FkDescriptor> BuildForeignKeys(MetaObject entity, MetaRoot root)
    {
        var owningTable = entity.FindPrimaryWritableSource()?.TableName ?? entity.Name;
        foreach (var refId in entity.ReferenceIdentities().Where(r => r.Enforce))
        {
            if (refId.TargetEntity is not { } targetName || refId.Fields.Count == 0) continue;
            var target = root.FindObject(CSharpNaming.StripPkg(targetName));
            if (target is null) continue;

            var cols = refId.Fields.Select(n => ResolveColumn(entity, n)).ToList();
            var refCols = refId.TargetFields.Count > 1
                ? refId.TargetFields.Select(n => ResolveColumn(target, n)).ToList()
                : [ResolveColumn(target, ResolvedTargetPkField(target, refId))];
            var refTable = target.FindPrimaryWritableSource()?.TableName ?? target.Name;
            var actions = ReferentialActions.Resolve(entity, targetName);

            yield return new FkDescriptor(
                Name: $"{owningTable}_{cols[0]}_fk",
                Columns: cols,
                RefTable: refTable,
                RefColumns: refCols,
                OnDelete: actions.OnDelete,
                OnUpdate: actions.OnUpdate);
        }
    }

    // Single target column a reference resolves to: the lone explicit @references
    // field, else the target's primary-identity first field, else "id".
    private static string ResolvedTargetPkField(MetaObject target, MetaReferenceIdentity fk) =>
        fk.TargetFields.Count == 1
            ? fk.TargetFields[0]
            : target.PrimaryIdentity()?.Fields.FirstOrDefault() ?? "id";

    private static string ResolveColumn(MetaObject owner, string fieldName) =>
        owner.Fields().FirstOrDefault(f => f.Name == fieldName)?.DbColumn ?? fieldName;
}
