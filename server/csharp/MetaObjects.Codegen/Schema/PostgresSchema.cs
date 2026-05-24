// PostgresSchema — emits Postgres DDL from metadata: CREATE TABLE per entity
// (columns/PK/NOT NULL/UNIQUE) and CREATE VIEW per read-only projection.
//
// Column + table names mirror the EF Core generators ([Table]/[Column] use the
// dbTable/dbColumn override or the raw name), so the generated entities map onto
// this schema. View SELECTs are derived from field origins: passthrough (plain
// column), passthrough-@via (to-one correlated subquery), aggregate (to-many
// correlated subquery), and collection (json_agg over a to-many). FK columns are
// resolved from identity.reference; an unresolvable origin leaves a TODO comment
// (+ warning) rather than emitting incorrect SQL.
//
// Shape note: aggregates use a correlated subquery per origin, not the TS
// reference's LEFT JOIN + GROUP BY (view-ddl-emit.ts). Both produce the same view
// rows; subqueries scope each to-many independently, so multiple aggregates over
// different relationships can't fan-out/double-count (the reason TS needs
// COUNT(DISTINCT), which still mis-sums SUM/AVG across joins). View DDL is a
// generated artifact, not a conformance-pinned invariant — the SQL form is free.
//
// DIVERGENCE from Migrate/PostgresEmit (the incremental-migration engine): this
// full-CREATE emitter uses unquoted identifiers, lowercase types (varchar/integer/
// jsonb), an unnamed inline PRIMARY KEY, and "{table}_{name}_uniq" index names;
// PostgresEmit uses quoted idents, UPPERCASE types, a "{table}_pkey" constraint, and
// raw index names. The two MUST be reconciled before introspection-driven migration
// goes live (else a diff sees spurious churn) — preferably by retiring this CREATE
// TABLE in favor of routing full-CREATE through the snapshot+emit pipeline. Tracked
// in the csharp-migration-pipeline-status memory.

using System.Text;
using MetaObjects.Core.Documentation;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen.Schema;

/// <summary>Postgres DDL generation from a loaded model.</summary>
public static class PostgresSchema
{
    /// <summary>Field subtype -> Postgres column type (varchar(n) when @maxLength is set).</summary>
    public static string PgType(MetaField field) => field.SubType switch
    {
        FIELD_SUBTYPE_STRING or FIELD_SUBTYPE_CLASS =>
            field.MaxLength is long n ? $"varchar({n})" : "text",
        FIELD_SUBTYPE_INT       => "integer",
        FIELD_SUBTYPE_SHORT     => "smallint",
        FIELD_SUBTYPE_BYTE      => "smallint",
        FIELD_SUBTYPE_LONG      => "bigint",
        FIELD_SUBTYPE_CURRENCY  => "bigint",      // integer minor units
        FIELD_SUBTYPE_DOUBLE    => "double precision",
        FIELD_SUBTYPE_FLOAT     => "real",
        FIELD_SUBTYPE_DECIMAL   => field.Precision is long p
            ? $"numeric({p}, {field.Scale ?? 0})" : "numeric",
        FIELD_SUBTYPE_ENUM      => "text",        // string-backed; CHECK constraint added in CreateTable
        FIELD_SUBTYPE_BOOLEAN   => "boolean",
        FIELD_SUBTYPE_DATE      => "date",
        FIELD_SUBTYPE_TIME      => "time",
        FIELD_SUBTYPE_TIMESTAMP => "timestamp",
        _ => "text",
    };

    /// <summary>
    /// CREATE TABLE for a writable entity: scalar columns + object-field storage
    /// (@storage flattened → prefixed columns; else a single jsonb column) + PK +
    /// NOT NULL + UNIQUE indexes + FOREIGN KEY constraints (from enforced
    /// identity.reference children).
    /// </summary>
    public static string CreateTable(MetaObject entity, MetaRoot root)
    {
        var table = CSharpNaming.Table(entity);
        var pk = entity.PrimaryIdentity();

        var lines = new List<string>();
        foreach (var f in entity.Fields())
        {
            if (CSharpNaming.ScalarFor(f.SubType) is not null || f.SubType == FIELD_SUBTYPE_ENUM)
            {
                var notNull = CSharpNaming.IsRequired(entity, f) ? " NOT NULL" : string.Empty;
                // isArray scalar/enum columns persist as jsonb (an array of values, not a
                // single scalar). Consistent with object-array (.ToJson) and EF's
                // primitive-collection jsonb mapping.
                var pgType = f.IsArray ? "jsonb" : PgType(f);
                lines.Add($"  {CSharpNaming.Column(f)} {pgType}{notNull}");
            }
            else if (f.SubType == FIELD_SUBTYPE_OBJECT)
            {
                lines.AddRange(ObjectFieldColumns(entity, f, root));
            }
        }
        if (pk is not null && pk.Fields.Count > 0)
        {
            // Preserve the identity's declared @fields order (not field-declaration order).
            var cols = pk.Fields.Select(name => ResolveColumn(entity, name));
            lines.Add($"  PRIMARY KEY ({string.Join(", ", cols)})");
        }
        // FOREIGN KEY constraints from enforced identity.reference children.
        foreach (var fk in entity.ReferenceIdentities().Where(r => r.Enforce))
        {
            if (ForeignKeyClause(entity, fk, root) is { } clause) lines.Add(clause);
        }

        // CHECK constraints for scalar enum-typed fields (one per non-array field with @values).
        // Array-of-enum columns are jsonb (they hold a JSON array, not a single scalar value),
        // so a per-row IN(...) CHECK is incorrect and must be suppressed.
        foreach (var f in entity.Fields().Where(f => f.SubType == FIELD_SUBTYPE_ENUM &&
                                                     !f.IsArray &&
                                                     f.EffectiveEnumValues is { Count: > 0 }))
        {
            var col = CSharpNaming.Column(f);
            var list = string.Join(", ", f.EffectiveEnumValues!.Select(v => $"'{v.Replace("'", "''")}'"));
            lines.Add($"  CHECK ({col} IN ({list}))");
        }

        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE {table} (");
        sb.AppendLine(string.Join(",\n", lines));
        sb.AppendLine(");");

        // UNIQUE indexes from secondary identities marked unique.
        foreach (var sec in entity.SecondaryIdentities().Where(i => i.Unique))
        {
            var cols = sec.Fields.Select(name => ResolveColumn(entity, name));
            sb.AppendLine($"CREATE UNIQUE INDEX {table}_{sec.Name}_uniq ON {table} ({string.Join(", ", cols)});");
        }

        // COMMENT ON TABLE / COLUMN from @description (entity- and field-level).
        // @notes is intentionally never read — D5 contract.
        if (entity.Attr(DocumentationConstants.DOC_ATTR_DESCRIPTION) is string entityDesc && entityDesc.Length > 0)
        {
            sb.AppendLine($"COMMENT ON TABLE {table} IS '{PgEscape(entityDesc)}';");
        }
        foreach (var f in entity.Fields())
        {
            if (f.Attr(DocumentationConstants.DOC_ATTR_DESCRIPTION) is string fieldDesc && fieldDesc.Length > 0)
            {
                var col = CSharpNaming.Column(f);
                sb.AppendLine($"COMMENT ON COLUMN {table}.\"{col}\" IS '{PgEscape(fieldDesc)}';");
            }
        }

        return sb.ToString();
    }

    // Columns for an object-typed field. @storage flattened expands each nested
    // scalar field as "{parentCol}_{nestedCol}" (the parent emits no column of its
    // own); every other storage (jsonb / subdocument / absent) collapses to one
    // jsonb column — a relational target can't materialize a document store inline.
    private static IEnumerable<string> ObjectFieldColumns(MetaObject entity, MetaField f, MetaRoot root)
    {
        if (f.Storage == STORAGE_FLATTENED && f.ObjectRef is { } oref &&
            root.FindObject(CSharpNaming.StripPkg(oref)) is { } nested)
        {
            var prefix = CSharpNaming.Column(f) + "_";
            foreach (var nf in nested.Fields().Where(n => CSharpNaming.ScalarFor(n.SubType) is not null))
            {
                var notNull = CSharpNaming.IsRequired(nested, nf) ? " NOT NULL" : string.Empty;
                yield return $"  {prefix}{CSharpNaming.Column(nf)} {PgType(nf)}{notNull}";
            }
            yield break;
        }
        var topNotNull = CSharpNaming.IsRequired(entity, f) ? " NOT NULL" : string.Empty;
        yield return $"  {CSharpNaming.Column(f)} jsonb{topNotNull}";
    }

    // A table-level FOREIGN KEY constraint for an enforced reference identity.
    // FK columns keep the reference's declared @fields order; target columns are
    // the explicit dotted @references fields (multi-col) or the target's primary
    // identity (single-col / bare form), falling back to "id".
    private static string? ForeignKeyClause(MetaObject entity, MetaReferenceIdentity fk, MetaRoot root)
    {
        if (fk.TargetEntity is not { } targetName || fk.Fields.Count == 0) return null;
        var target = root.FindObject(CSharpNaming.StripPkg(targetName));
        if (target is null) return null;

        var fkCols = fk.Fields.Select(js => ResolveColumn(entity, js)).ToList();
        var refCols = fk.TargetFields.Count > 1
            ? fk.TargetFields.Select(tf => ResolveColumn(target, tf)).ToList()
            : [ResolveColumn(target, ResolvedTargetPkField(target, fk))];

        var name = $"{CSharpNaming.Table(entity)}_{fkCols[0]}_fk";
        var refTable = CSharpNaming.Table(target);
        return $"  CONSTRAINT {name} FOREIGN KEY ({string.Join(", ", fkCols)}) " +
               $"REFERENCES {refTable} ({string.Join(", ", refCols)})";
    }

    // The single target column a reference resolves to: the lone explicit @references
    // field, else the target's primary-identity first field, else "id".
    private static string ResolvedTargetPkField(MetaObject target, MetaReferenceIdentity fk) =>
        fk.TargetFields.Count == 1
            ? fk.TargetFields[0]
            : target.PrimaryIdentity()?.Fields.FirstOrDefault() ?? "id";

    /// <summary>
    /// CREATE VIEW for a projection. Derives the SELECT from field origins:
    /// passthrough (single base) → a plain column; aggregate (@agg/@of/@via) → a
    /// correlated subquery whose FK is resolved from an identity.reference on the
    /// target entity. Multi-base, @via passthrough, collection, or an unresolvable
    /// FK leave the view as a TODO comment (+ warning) rather than wrong SQL.
    /// </summary>
    public static string CreateView(MetaObject projection, MetaRoot root, Action<string> warn)
    {
        var view = projection.DbView!;
        var cols = new List<string>();
        string? baseEntity = null;
        string? blocked = null;
        const string T = "t"; // target alias inside correlated subqueries (self-reference safe)

        string BaseTable() => root.FindObject(baseEntity!)?.DbTable ?? baseEntity!;

        foreach (var f in projection.Fields())
        {
            var origin = f.OwnChildren().FirstOrDefault(c => c.Type == TYPE_ORIGIN);

            // passthrough, no via → a plain column off the single base.
            if (origin is MetaPassthroughOrigin pt && pt.Via is null && pt.From is { } from && from.Contains('.'))
            {
                var (ent, field) = SplitDot(from);
                baseEntity ??= CSharpNaming.StripPkg(ent);
                if (CSharpNaming.StripPkg(ent) != baseEntity) { blocked = "passthrough from multiple base entities"; break; }
                cols.Add($"  {ResolveColumn(root.FindObject(baseEntity), field)} AS {CSharpNaming.Column(f)}");
            }
            // passthrough WITH via → forward a field from a to-one related entity (correlated subquery).
            else if (origin is MetaPassthroughOrigin ptv && ptv.Via is { } pvia && ptv.From is { } pfrom &&
                     pvia.Contains('.') && pfrom.Contains('.'))
            {
                var (baseEnt, relName) = SplitDot(pvia);
                baseEntity ??= CSharpNaming.StripPkg(baseEnt);
                if (CSharpNaming.StripPkg(baseEnt) != baseEntity) { blocked = "passthrough via a different base entity"; break; }
                if (ToOneFk(root, baseEntity, relName) is not { } fk)
                { blocked = $"unresolved to-one FK for @via \"{pvia}\" (base needs an identity.reference)"; break; }
                var srcCol = ResolveColumn(fk.Target, SplitDot(pfrom).Tail);
                cols.Add($"  (SELECT {T}.{srcCol} FROM {fk.TargetTable} {T} WHERE {T}.{fk.TargetKeyCol} = {BaseTable()}.{fk.BaseFkCol}) AS {CSharpNaming.Column(f)}");
            }
            // aggregate → count/sum/... over a to-many relationship (correlated subquery).
            else if (origin is MetaAggregateOrigin agg && agg.Agg is { } aggFn && agg.Of is { } of && agg.Via is { } via &&
                     of.Contains('.') && via.Contains('.'))
            {
                var (baseEnt, relName) = SplitDot(via);
                baseEntity ??= CSharpNaming.StripPkg(baseEnt);
                if (CSharpNaming.StripPkg(baseEnt) != baseEntity) { blocked = "aggregate over a different base entity"; break; }
                if (ToManyFk(root, baseEntity, relName) is not { } fk)
                { blocked = $"unresolved to-many FK for @via \"{via}\" (target needs an identity.reference back to {baseEntity})"; break; }
                var ofCol = ResolveColumn(fk.Target, SplitDot(of).Tail);
                cols.Add($"  (SELECT {aggFn}({T}.{ofCol}) FROM {fk.TargetTable} {T} WHERE {T}.{fk.FkCol} = {BaseTable()}.{fk.ParentCol}) AS {CSharpNaming.Column(f)}");
            }
            // collection → array of nested view-objects over a to-many relationship (json_agg).
            else if (origin is MetaCollectionOrigin coll && coll.Via is { } cvia && cvia.Contains('.') && f.ObjectRef is { } objRef)
            {
                var (baseEnt, relName) = SplitDot(cvia);
                baseEntity ??= CSharpNaming.StripPkg(baseEnt);
                if (CSharpNaming.StripPkg(baseEnt) != baseEntity) { blocked = "collection over a different base entity"; break; }
                var nested = root.FindObject(CSharpNaming.StripPkg(objRef));
                if (ToManyFk(root, baseEntity, relName) is not { } fk || nested is null)
                { blocked = $"unresolved collection @via \"{cvia}\" / @objectRef \"{objRef}\""; break; }
                var pairs = nested.Fields()
                    .Where(nf => CSharpNaming.ScalarFor(nf.SubType) is not null)
                    .Select(nf => $"'{nf.Name}', {T}.{ResolveColumn(fk.Target, nf.Name)}");
                cols.Add($"  (SELECT coalesce(json_agg(json_build_object({string.Join(", ", pairs)})), '[]'::json) " +
                         $"FROM {fk.TargetTable} {T} WHERE {T}.{fk.FkCol} = {BaseTable()}.{fk.ParentCol}) AS {CSharpNaming.Column(f)}");
            }
            else
            {
                blocked = "field has no resolvable origin";
                break;
            }
        }

        if (blocked is not null || baseEntity is null || cols.Count == 0)
        {
            warn($"meta migrate: view \"{view}\" not generated — {blocked ?? "no derivable columns"}.");
            return $"-- TODO CREATE VIEW {view}: {blocked ?? "no derivable columns"}\n";
        }

        return $"CREATE VIEW {view} AS\nSELECT\n{string.Join(",\n", cols)}\nFROM {BaseTable()};\n";
    }

    private static (string Head, string Tail) SplitDot(string s)
    {
        var i = s.IndexOf('.');
        return (s[..i], s[(i + 1)..]);
    }

    private static string ResolveColumn(MetaObject? obj, string fieldName) =>
        obj?.Fields().FirstOrDefault(f => f.Name == fieldName)?.DbColumn ?? fieldName;

    // Resolve a named relationship on the base entity to its (base, target) objects.
    private static (MetaObject Base, MetaObject Target)? ResolveRelation(
        MetaRoot root, string baseEntity, string relName)
    {
        var baseObj = root.FindObject(baseEntity);
        var rel = baseObj?.Relationships().FirstOrDefault(r => r.Name == relName);
        if (baseObj is null || rel?.ObjectRef is not { } objRef) return null;
        var target = root.FindObject(CSharpNaming.StripPkg(objRef));
        return target is null ? null : (baseObj, target);
    }

    // Resolve a to-many relationship to the FK that lives on the *target* entity:
    // the target carries an identity.reference back to the base. Used by aggregate
    // and collection origins (subquery scans the target, filtered by the base PK).
    private static (MetaObject Target, string TargetTable, string FkCol, string ParentCol)? ToManyFk(
        MetaRoot root, string baseEntity, string relName)
    {
        if (ResolveRelation(root, baseEntity, relName) is not { } rel) return null;
        var (baseObj, target) = rel;

        var fkRef = target.ReferenceIdentities()
            .FirstOrDefault(r => r.TargetEntity is { } te && CSharpNaming.StripPkg(te) == baseEntity);
        if (fkRef is null || fkRef.Fields.Count == 0) return null;

        var fkCol = ResolveColumn(target, fkRef.Fields[0]);
        var parentField = fkRef.TargetFields.Count > 0
            ? fkRef.TargetFields[0]
            : baseObj.PrimaryIdentity()?.Fields.FirstOrDefault();
        if (parentField is null) return null;

        return (target, CSharpNaming.Table(target), fkCol, ResolveColumn(baseObj, parentField));
    }

    // Resolve a to-one relationship to the FK that lives on the *base* entity:
    // the base carries an identity.reference at the target. Used by passthrough-@via
    // origins (subquery selects from the target, joined on the base's FK column).
    private static (MetaObject Target, string TargetTable, string TargetKeyCol, string BaseFkCol)? ToOneFk(
        MetaRoot root, string baseEntity, string relName)
    {
        if (ResolveRelation(root, baseEntity, relName) is not { } rel) return null;
        var (baseObj, target) = rel;

        var fkRef = baseObj.ReferenceIdentities()
            .FirstOrDefault(r => r.TargetEntity is { } te && CSharpNaming.StripPkg(te) == target.Name);
        if (fkRef is null || fkRef.Fields.Count == 0) return null;

        var baseFkCol = ResolveColumn(baseObj, fkRef.Fields[0]);
        var targetKeyField = fkRef.TargetFields.Count > 0
            ? fkRef.TargetFields[0]
            : target.PrimaryIdentity()?.Fields.FirstOrDefault();
        if (targetKeyField is null) return null;

        return (target, CSharpNaming.Table(target), ResolveColumn(target, targetKeyField), baseFkCol);
    }

    /// <summary>Escape a string for use in a Postgres single-quoted string literal.</summary>
    private static string PgEscape(string s) => s.Replace("'", "''");

    /// <summary>Full schema DDL: tables for writable entities, then views for projections.</summary>
    public static string BuildSchema(MetaRoot root, Action<string>? warn = null)
    {
        var warnFn = warn ?? (_ => { });
        var sb = new StringBuilder();
        sb.AppendLine("-- Generated by MetaObjects meta migrate (Postgres). Do not edit by hand.");
        sb.AppendLine();

        foreach (var e in root.Objects().Where(o => o.IsEntity() && !o.IsReadOnlyProjection())
                     .OrderBy(o => o.Name, StringComparer.Ordinal))
        {
            sb.AppendLine(CreateTable(e, root));
        }
        foreach (var p in root.Objects().Where(o => o.IsReadOnlyProjection())
                     .OrderBy(o => o.Name, StringComparer.Ordinal))
        {
            sb.AppendLine(CreateView(p, root, warnFn));
        }
        return sb.ToString();
    }
}
