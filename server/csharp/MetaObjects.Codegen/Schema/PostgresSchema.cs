// PostgresSchema — supplemental Postgres DDL emission alongside the migration engine.
//
// Tables, primary keys, NOT NULL, FKs, unique indexes, identity columns, and array
// columns all flow through ExpectedSchema + SchemaDiff + PostgresEmit (the engine).
// This file holds DDL the engine snapshot doesn't yet model — invoked from
// MigrateCommand.Run as a tail-append after the engine renders the table CREATEs:
//
//   * CREATE VIEW per read-only projection. Derived from field origins —
//     passthrough (plain column), passthrough-@via (to-one correlated subquery),
//     aggregate (to-many subquery), collection (json_agg over a to-many) — with
//     FK columns resolved from identity.reference. An unresolvable origin leaves
//     a TODO comment (+ warning) rather than emitting incorrect SQL.
//   * ALTER TABLE ADD CONSTRAINT ... CHECK for scalar enum-typed fields (with
//     stable {table}_{column}_check naming, suppressed for array-of-enum which
//     is jsonb).
//   * COMMENT ON TABLE / COLUMN from the @description attr (@notes is never
//     read — D5 documentation-provider contract).
//
// Shape note: view aggregates use a correlated subquery per origin (not the TS
// reference's LEFT JOIN + GROUP BY). Independent to-many aggregates can't
// fan-out/double-count this way (TS needs COUNT(DISTINCT), which still mis-sums
// SUM/AVG across joins). View DDL is a generated artifact, not a conformance-
// pinned invariant — the SQL form is free.

using MetaObjects.Core.Documentation;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen.Schema;

/// <summary>Postgres DDL generation from a loaded model.</summary>
public static class PostgresSchema
{

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

        // All emitted identifiers are quoted (engine convention) so mixed-case column
        // names like "programId" round-trip through PG without being silently
        // lowercased. The bare alias `t` is intentionally unquoted (it's never a
        // user identifier and PG treats it case-insensitively as lowercase).
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
                cols.Add($"  \"{ResolveColumn(root.FindObject(baseEntity), field)}\" AS \"{CSharpNaming.Column(f)}\"");
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
                cols.Add($"  (SELECT {T}.\"{srcCol}\" FROM \"{fk.TargetTable}\" {T} WHERE {T}.\"{fk.TargetKeyCol}\" = \"{BaseTable()}\".\"{fk.BaseFkCol}\") AS \"{CSharpNaming.Column(f)}\"");
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
                cols.Add($"  (SELECT {aggFn}({T}.\"{ofCol}\") FROM \"{fk.TargetTable}\" {T} WHERE {T}.\"{fk.FkCol}\" = \"{BaseTable()}\".\"{fk.ParentCol}\") AS \"{CSharpNaming.Column(f)}\"");
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
                // json_build_object keys are JSON string literals (single-quoted), not idents — left unquoted-as-ident.
                var pairs = nested.Fields()
                    .Where(nf => CSharpNaming.ScalarFor(nf.SubType) is not null)
                    .Select(nf => $"'{nf.Name}', {T}.\"{ResolveColumn(fk.Target, nf.Name)}\"");
                cols.Add($"  (SELECT coalesce(json_agg(json_build_object({string.Join(", ", pairs)})), '[]'::json) " +
                         $"FROM \"{fk.TargetTable}\" {T} WHERE {T}.\"{fk.FkCol}\" = \"{BaseTable()}\".\"{fk.ParentCol}\") AS \"{CSharpNaming.Column(f)}\"");
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

        return $"CREATE VIEW \"{view}\" AS\nSELECT\n{string.Join(",\n", cols)}\nFROM \"{BaseTable()}\";\n";
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
    // -----------------------------------------------------------------------
    // Engine-supplement tail-append helpers — invoked by MigrateCommand.Run
    // after the engine emits the table DDL. Each emits per-entity SQL the
    // engine snapshot does NOT yet model (introspection ignores them, so they
    // never appear as drift in `meta migrate --from-db`).
    // -----------------------------------------------------------------------

    /// <summary>
    /// CHECK constraints for scalar enum fields, one per non-array enum with @values.
    /// Emitted as standalone <c>ALTER TABLE ... ADD CONSTRAINT ... CHECK</c> rather than
    /// inline inside CREATE TABLE so they layer cleanly on top of engine-emitted DDL.
    /// Naming: <c>{table}_{column}_check</c> (stable enough for a future introspection
    /// pass to match). Array-of-enum columns are jsonb and don't get a per-row IN check.
    /// </summary>
    public static IEnumerable<string> EnumCheckConstraints(MetaRoot root) =>
        WritableEntitiesByName(root).SelectMany(e =>
        {
            var table = CSharpNaming.Table(e);
            return e.Fields()
                .Where(f => f.SubType == FIELD_SUBTYPE_ENUM && !f.IsArray
                            && f.EffectiveEnumValues is { Count: > 0 })
                .Select(f =>
                {
                    var col = CSharpNaming.Column(f);
                    var list = string.Join(", ", f.EffectiveEnumValues!.Select(v => $"'{PgSql.Escape(v)}'"));
                    return $"ALTER TABLE \"{table}\" ADD CONSTRAINT \"{table}_{col}_check\" CHECK (\"{col}\" IN ({list}));";
                });
        });

    /// <summary>
    /// <c>COMMENT ON TABLE</c> + <c>COMMENT ON COLUMN</c> statements from the
    /// <c>@description</c> attr. The <c>@notes</c> attr is intentionally never read
    /// (internal-only rationale slot, per the documentation provider D5 contract).
    /// </summary>
    public static IEnumerable<string> TableAndColumnComments(MetaRoot root)
    {
        foreach (var e in WritableEntitiesByName(root))
        {
            var table = CSharpNaming.Table(e);
            if (Description(e) is { } entityDesc)
                yield return $"COMMENT ON TABLE \"{table}\" IS '{PgSql.Escape(entityDesc)}';";
            foreach (var f in e.Fields())
                if (Description(f) is { } fieldDesc)
                    yield return $"COMMENT ON COLUMN \"{table}\".\"{CSharpNaming.Column(f)}\" IS '{PgSql.Escape(fieldDesc)}';";
        }
    }

    // Shared writable-entity iterator: matches ExpectedSchema.Build's filter + ordering
    // so the tail-append helpers iterate the same set the engine produced CREATE TABLE for.
    private static IEnumerable<MetaObject> WritableEntitiesByName(MetaRoot root) =>
        root.Objects()
            .Where(o => o.IsEntity() && o.FindPrimaryWritableSource() is not null)
            .OrderBy(o => o.Name, StringComparer.Ordinal);

    // Non-empty @description value, or null. Centralizes the "description is missing
    // or blank" check so both table + column comment emission agree.
    private static string? Description(MetaData node) =>
        node.Attr(DocumentationConstants.DOC_ATTR_DESCRIPTION) is string s && s.Length > 0 ? s : null;
}
