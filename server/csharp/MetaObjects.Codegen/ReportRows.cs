// report-rows — how a view-backed `object.report` reaches the EF Core generators (FR-044).
//
// WHAT IS GENERATED
//
// A report that declares a read-only `source.rdb @kind: view` is a database view
// (contract Table A). C# has no metadata-driven runtime, so reading that view means
// generating its row: a keyless entity class (EntityGenerator) and its
// `HasNoKey().ToView(...)` mapping plus a DbSet (DbContextGenerator). Nothing else is
// generated for a report: no routes, filter allowlist, names artifact or api docs.
//
// The view's existence is what matters, not who creates it. `@unmanaged: true` (migrate
// never creates it) and `@sql` (the author wrote the body) both still name a view with
// the Table B columns, so both still get a row. A report with no source stays inert, and
// so does one whose read source is a materialized view, a stored procedure or a table
// function: the lowering skips those kinds, so no relation with the Table B columns is
// promised to exist.
//
// WHY A SYNTHESIZED OBJECT, NOT A REPORT BRANCH IN EACH GENERATOR
//
// A report declares no fields; its read shape is derived (ReportShapes, Table B). The EF
// generators read an object's fields through `Fields()` in a dozen places (members, enum
// declarations, usings, the enum and jsonb conversions in the DbContext). A view-backed
// report already satisfies their projection predicates (`IsReadOnlyProjection()`,
// `DbView`), so it is handed to them as a ROW MODEL: a detached object with one real
// `field.*` child per derived field and a copy of the report's read source. They then
// emit it exactly as they emit a keyless read-only projection.
//
// The row model is never added to the root and nothing in the loaded tree is mutated to
// build it (the source is copied, not re-parented). It keeps the report's name, package
// and `object.report` subtype, so `IsReport()` still identifies it.
//
// Mirrors server/typescript/packages/metadata/src/core/reporting/report-read-model.ts.

using MetaObjects.Core.Reporting;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Persistence.Db.DbConstants;
using static MetaObjects.Persistence.Source.SourceConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen;

/// <summary>Row models for view-backed reports, and the object set the EF generators iterate.</summary>
public static class ReportRows
{
    /// <summary>
    /// Table B: the type-shaping attrs a derived field carries from its type source.
    /// <c>@dbColumnType</c> and <c>isArray</c> are handled separately. Nothing else is
    /// carried: no <c>@column</c>, <c>@required</c>, <c>@default</c>, validators or views.
    /// </summary>
    private static readonly string[] CarriedAttrs =
    [
        FIELD_ATTR_CURRENCY,
        FIELD_ATTR_VALUES,
        FIELD_ATTR_INT_VALUE_MAP,
        FIELD_ATTR_MAX_LENGTH,
        FIELD_ATTR_PRECISION,
        FIELD_ATTR_SCALE,
        FIELD_ATTR_LOCAL_TIME,
        FIELD_ATTR_OBJECT_REF,
        FIELD_ATTR_STORAGE,
    ];

    /// <summary>
    /// True iff <paramref name="obj"/> is a report whose read source is a view, the one
    /// shape that generates a row (see the file header for the other kinds).
    /// </summary>
    public static bool IsViewBacked(MetaObject obj) =>
        obj.IsReport() && !obj.IsAbstract
        && ReportShapes.ReadSource(obj)?.EffectiveKind == SOURCE_KIND_VIEW;

    /// <summary>
    /// The row model of a view-backed report: one field per Table B row, in Table B
    /// order, and a copy of the report's read source. Frozen. Throws what
    /// <see cref="ReportShapes.Of"/> throws when a reference does not resolve.
    /// </summary>
    public static MetaObject RowModel(MetaObject report, MetaRoot root)
    {
        var source = ReportShapes.ReadSource(report)
            ?? throw new InvalidOperationException($"report '{report.Name}' declares no read-only source.");
        var shape = ReportShapes.Of(report, root);

        var model = new MetaObject(new TypeId(report.Type, report.SubType), report.Name);
        if (report.Package is { } pkg) model.SetPackage(pkg);
        // The file-default package has no getter; the effective package is what it resolves to.
        string effectivePkg = NamingRefs.EffectivePackage(report);
        if (effectivePkg.Length > 0) model.SetFileDefaultPackage(effectivePkg);
        model.SetSource(report.Source);

        foreach (var f in shape.Fields) model.AddChild(DerivedField(f));
        model.AddChild(CopySource(source));
        model.Freeze();
        return model;
    }

    private static MetaField DerivedField(ReportField f)
    {
        var field = new MetaField(new TypeId(TYPE_FIELD, f.SubType), f.Name);
        // From the derived shape, never from the type source: a `min` of a required column
        // is still nullable, and a dimension reached by `@via` is nullable.
        field.SetAttr(FIELD_ATTR_REQUIRED, f.Required);
        if (f.TypeSource is { } src)
        {
            // ADR-0039: resolving, so a value the `@of` field inherits through extends is carried.
            foreach (string name in CarriedAttrs)
                if (src.Attr(name) is { } value) field.SetAttr(name, value);
            // ADR-0039: own — `@dbColumnType` is the one deliberately own-only attr (a
            // physical column-type override is never inherited), so the derived field
            // carries exactly what the `@of` field itself declares.
            if (src.OwnAttr(FIELD_ATTR_DB_COLUMN_TYPE) is { } dbColumnType)
                field.SetAttr(FIELD_ATTR_DB_COLUMN_TYPE, dbColumnType);
            // `isArray` is a native flag, not an attr; ResolvedIsArray() is its resolving read.
            if (src.ResolvedIsArray()) field.SetIsArray(true);
        }
        return field;
    }

    /// <summary>
    /// A detached copy of a source node: same type, name and effective attrs, pinned to
    /// <c>@role: primary</c> so <see cref="MetaObject.DbView"/> (which considers primary
    /// sources only) names it.
    /// </summary>
    private static MetaSource CopySource(MetaSource source)
    {
        var copy = new MetaSource(new TypeId(source.Type, source.SubType), source.Name);
        // ADR-0039: resolving — the copy carries the source's effective configuration.
        foreach (var (name, value) in source.Attrs()) copy.SetAttr(name, value);
        copy.SetAttr(SOURCE_ATTR_ROLE, SOURCE_ROLE_PRIMARY);
        return copy;
    }

    /// <summary>The row model of every view-backed report in the model, in declaration order.</summary>
    public static IReadOnlyList<MetaObject> For(MetaRoot root) =>
        root.Objects().Where(IsViewBacked).Select(r => RowModel(r, root)).ToList();

    /// <summary>
    /// The objects a row-emitting generator iterates: the run's entity set with every
    /// report node removed, then the row model of each view-backed report.
    /// <para>
    /// The row models come from the root, not from <see cref="GenContext.Entities"/>:
    /// <see cref="CodegenRunner"/> keeps every report out of that set, which is what
    /// keeps a report inert in every generator that does not ask for it here. A caller
    /// that builds a context from the unfiltered root gets the same answer, because a
    /// raw report node in the entity set is dropped rather than emitted as a class with
    /// no members.
    /// </para>
    /// </summary>
    public static IReadOnlyList<MetaObject> WithReportRows(GenContext ctx) =>
        [.. ctx.Entities.Where(o => !o.IsReport()), .. For(ctx.Root)];
}
