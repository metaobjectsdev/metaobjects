// A report's derived fields (FR-044, contract Table B): one field per `@dimensions` item
// in listed order, then one per `@measures` item in listed order. `required` follows
// Table C of docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md,
// which amends Table B for a report with `@spine` and a measure with `@default`.
//
// Ported rule for rule from
// server/typescript/packages/metadata/src/core/reporting/report-shape.ts, and gated
// against it by fixtures/persistence-conformance/report-shapes.json (the TS-produced
// artifact every port byte-matches; see ReportShapeTests).

using System.Text;
using MetaObjects.Loader;
using MetaObjects.Meta;

namespace MetaObjects.Core.Reporting;

/// <summary>Whether a derived report field comes from a dimension or a measure.</summary>
public enum ReportFieldRole
{
    Dimension,
    Measure,
}

/// <summary>One derived field of a report (one Table B row).</summary>
/// <param name="Name">The derived field name; the physical column is the naming strategy applied to it.</param>
/// <param name="Role">Dimension or measure.</param>
/// <param name="SubType">A field subtype name (<c>FIELD_SUBTYPE_*</c>).</param>
/// <param name="Required">False when the column can be null.</param>
/// <param name="TypeSource">The <c>@of</c> field whose type-shaping attrs this field carries, or null.</param>
/// <param name="Dimension">The dimension node, for a dimension field.</param>
/// <param name="Grain">The time grain, for a <c>dimension.time</c> field.</param>
/// <param name="Measure">The measure node, for a measure field.</param>
public sealed record ReportField(
    string Name,
    ReportFieldRole Role,
    string SubType,
    bool Required,
    MetaField? TypeSource = null,
    MetaDimension? Dimension = null,
    string? Grain = null,
    MetaMeasure? Measure = null);

/// <summary>The read shape of an <c>object.report</c>.</summary>
/// <param name="Report">The report node.</param>
/// <param name="From">The resolved <c>@from</c> entity.</param>
/// <param name="Fields">The derived fields, dimensions first, in declared order.</param>
public sealed record ReportShape(MetaObject Report, MetaObject From, IReadOnlyList<ReportField> Fields);

/// <summary>Derives a report's read shape (Table B) and serialises the conformance artifact.</summary>
public static class ReportShapes
{
    private static readonly HashSet<string> SumLong =
        new(StringComparer.Ordinal) { FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG };

    private static readonly HashSet<string> Floating =
        new(StringComparer.Ordinal) { FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT };

    /// <summary>
    /// The entity that DECLARES a dimension or measure reached through <paramref name="from"/>:
    /// the member's parent, which is <paramref name="from"/> itself or an entity it extends. A
    /// bare entity name inside the member (<c>@of</c>, <c>@via</c>) resolves in THIS entity's
    /// package, exactly as the loader's <c>ValidateReporting</c> resolves it
    /// (<c>EffectivePackage(ctx.Declaring)</c>), never in <paramref name="from"/>'s package or
    /// the report's.
    /// </summary>
    public static MetaData ReportingMemberOwner(MetaData member, MetaObject from) => member.Parent ?? from;

    /// <summary>
    /// Resolve a dimension's or measure's <c>Entity.field</c> reference to the field node.
    /// The ONE rule, the same as the loader's (<c>ValidateReporting</c> D1 / M1) and as the
    /// TypeScript <c>resolveReportingFieldRef</c>:
    /// <list type="number">
    /// <item>The entity half resolves relative to the package of <paramref name="declaring"/>,
    /// the entity that declares the member (<see cref="ReportingMemberOwner"/>).</item>
    /// <item>With <paramref name="host"/> (a measure, or a dimension without <c>@via</c>: the
    /// reference is about the <c>@from</c> entity's own rows) the named entity must be
    /// <paramref name="host"/> or an entity it extends, and the field is read from
    /// <paramref name="host"/>, so a field it redeclares wins.</item>
    /// <item>Without <paramref name="host"/> (a dimension with <c>@via</c>) the field is read
    /// from the named entity.</item>
    /// </list>
    /// Null when any step fails.
    /// </summary>
    public static MetaField? ResolveReportingFieldRef(
        string reference, MetaData declaring, MetaRoot root, MetaObject? host = null) =>
        ResolveReportingFieldRefNamed(reference, declaring, root, host)?.Field;

    /// <summary>
    /// <see cref="ResolveReportingFieldRef"/>, also returning <c>Named</c>: the entity the
    /// reference's entity half names (which, with <paramref name="host"/>, may be an ancestor
    /// of the entity the field is read from). Table C reads <c>Named</c>'s primary identity.
    /// </summary>
    private static (MetaObject Named, MetaField Field)? ResolveReportingFieldRefNamed(
        string reference, MetaData declaring, MetaRoot root, MetaObject? host)
    {
        // `Entity.field`; a package qualifier uses `::`, so the member separator is the LAST dot.
        int dot = reference.LastIndexOf(CHILD_REF_SEPARATOR, StringComparison.Ordinal);
        if (dot <= 0) return null;
        if (NamingRefs.ResolveObjectRef(root, reference[..dot], NamingRefs.EffectivePackage(declaring))
            is not MetaObject named) return null;
        if (host is not null && !ValidationPasses.IsSelfOrAncestor(named, host)) return null;
        // ADR-0039: resolving, so a field inherited through extends is found.
        var field = (host ?? named).FindField(reference[(dot + CHILD_REF_SEPARATOR.Length)..]);
        return field is null ? null : (named, field);
    }

    /// <summary>
    /// The hop names of a dimension's <c>@via</c> (<c>Owner.hop[.hop...]</c>), read as the
    /// loader reads it (<c>ValidateReporting</c> rule D2): <c>Owner</c> resolves in the package
    /// of <paramref name="declaring"/> (<see cref="ReportingMemberOwner"/>) and must be
    /// <paramref name="from"/> or an entity <paramref name="from"/> extends. The walk itself
    /// then starts AT <paramref name="from"/>, whichever of the two <c>Owner</c> named. Null
    /// when the reference has no owner, no hop, or an owner that is not <paramref name="from"/>
    /// or an ancestor of it.
    /// </summary>
    public static string[]? ReportingViaHops(string via, MetaData declaring, MetaObject from, MetaRoot root)
    {
        // The owner ends at the first `.` after the last `::` (a package qualifier has no `.`).
        int lastSep = via.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        int segStart = lastSep == -1 ? 0 : lastSep + PACKAGE_SEPARATOR.Length;
        int dot = via.IndexOf(CHILD_REF_SEPARATOR, segStart, StringComparison.Ordinal);
        if (dot <= segStart) return null;
        string[] hops = via[(dot + CHILD_REF_SEPARATOR.Length)..].Split(CHILD_REF_SEPARATOR);
        if (hops.Any(h => h == "")) return null;
        var owner = NamingRefs.ResolveObjectRef(root, via[..dot], NamingRefs.EffectivePackage(declaring));
        if (owner is null || !ValidationPasses.IsSelfOrAncestor(owner, from)) return null;
        return hops;
    }

    private static InvalidOperationException Unresolved(string reportName, string what) =>
        new($"report '{reportName}': {what} does not resolve.");

    /// <summary>
    /// The hop names of a report's <c>@spine</c> (<c>Owner.hop[.hop...]</c>), read as
    /// <see cref="ReportingViaHops"/> reads a <c>@via</c>, the owner resolving in the REPORT's
    /// package (loader rule R8). Null when the report declares no <c>@spine</c>. Throws
    /// <see cref="InvalidOperationException"/> naming the report when a declared <c>@spine</c>
    /// does not resolve (a report that passed <c>ValidateReporting</c> always resolves):
    /// reading it as "no spine" would claim a column non-null that a spine row with no facts
    /// leaves null.
    /// </summary>
    public static string[]? ReportSpineHops(MetaObject report, MetaObject from, MetaRoot root)
    {
        string? spine = ReportAccessors.ReportSpine(report);
        if (spine is null) return null;
        return ReportingViaHops(spine, report, from, root) ?? throw Unresolved(report.Name, $"@spine '{spine}'");
    }

    /// <summary>True when <paramref name="field"/> is one of the <c>@fields</c> of <paramref name="entity"/>'s <c>identity.primary</c>.</summary>
    private static bool IsPrimaryKeyField(MetaObject entity, MetaField field)
    {
        // ADR-0039: resolving — an identity.primary (and its @fields) inherited from an
        // abstract base counts.
        var pk = entity.PrimaryIdentity();
        return pk is not null && (ValidationPasses.IdentityEffectiveFields(pk) ?? []).Contains(field.Name);
    }

    /// <summary>
    /// Table C (<c>required</c> of a dimension). Without <c>@spine</c>: only a dimension with
    /// no <c>@via</c> over an <c>@of</c> field whose effective <c>@required</c> is true. With
    /// <c>@spine</c>: only a dimension whose <c>@via</c> hops equal the spine's (a column of
    /// the spine entity itself, whose rows are the report's rows) over an <c>@of</c> field that
    /// is <c>@required</c> or a primary-key column of the entity <c>@of</c> names. A dimension
    /// beyond the spine is reached by a LEFT OUTER join.
    /// </summary>
    private static bool DimensionRequired(
        MetaDimension dim, MetaObject named, MetaField of, MetaObject from, MetaRoot root,
        string[]? spine, string reportName)
    {
        string? via = dim.Via();
        // The @required ATTR only, read resolving (ADR-0039); a validator.required child does not count.
        bool ofRequired = of.Attr(FIELD_ATTR_REQUIRED) is true;
        if (spine is null) return via is null && ofRequired;
        if (via is null) return false; // a column of @from: null in a spine row with no facts
        var hops = ReportingViaHops(via, ReportingMemberOwner(dim, from), from, root)
            ?? throw Unresolved(reportName, $"dimension '{dim.Name}' @via '{via}'");
        bool onSpine = hops.SequenceEqual(spine, StringComparer.Ordinal);
        return onSpine && (ofRequired || IsPrimaryKeyField(named, of));
    }

    private static T? DeclaredMember<T>(MetaObject from, string type, string name) where T : MetaData =>
        // ADR-0039: resolving Children(), so a member declared on an abstract base is found.
        from.Children().OfType<T>().FirstOrDefault(c => c.Type == type && c.Name == name);

    private static ReportField DimensionField(
        ReportDimensionItem item, MetaObject from, MetaRoot root, string reportName, string[]? spine)
    {
        var dim = DeclaredMember<MetaDimension>(from, TYPE_DIMENSION, item.Name)
            ?? throw Unresolved(reportName, $"dimension '{item.Name}' on '{from.Name}'");
        bool vialess = dim.Via() is null;
        var (named, of) = ResolveReportingFieldRefNamed(dim.Of() ?? "", ReportingMemberOwner(dim, from), root, vialess ? from : null)
            ?? throw Unresolved(reportName, $"dimension '{item.Name}' @of");
        string name = ReportAccessors.ReportDerivedFieldName(item);
        bool required = DimensionRequired(dim, named, of, from, root, spine, reportName);
        if (dim.IsTime())
        {
            // Loader rule R2 guarantees a grain from the closed set; a tree built in code does not.
            string? grain = item.Grain;
            if (grain is null || !TIME_GRAINS.Contains(grain, StringComparer.Ordinal))
                throw Unresolved(reportName, $"time dimension '{item.Name}' grain '{grain ?? ""}'");
            return grain == GRAIN_HOUR
                ? new ReportField(name, ReportFieldRole.Dimension, FIELD_SUBTYPE_TIMESTAMP, required, of, dim, grain)
                : new ReportField(name, ReportFieldRole.Dimension, FIELD_SUBTYPE_DATE, required, null, dim, grain);
        }
        return new ReportField(name, ReportFieldRole.Dimension, of.SubType, required, of, dim);
    }

    /// <summary>
    /// One <c>@measures</c> item, bare (<c>total</c>) or dotted (<c>Sale.total</c>, loader
    /// rule R3). The measure is named by the item's last segment and looked up on
    /// <paramref name="from"/>; a qualifier resolves in the REPORT's package and must be
    /// <paramref name="from"/> or an entity it extends.
    /// </summary>
    private static ReportField MeasureField(string item, MetaObject report, MetaObject from, MetaRoot root)
    {
        string reportName = report.Name;
        string name = ReportAccessors.ReportMeasureItemName(item);
        if (ReportAccessors.ReportMeasureItemOwner(item) is { } qualifier)
        {
            var owner = NamingRefs.ResolveObjectRef(root, qualifier, NamingRefs.EffectivePackage(report));
            if (owner is null || !ValidationPasses.IsSelfOrAncestor(owner, from))
                throw Unresolved(reportName, $"measure '{item}' on '{from.Name}'");
        }
        var m = DeclaredMember<MetaMeasure>(from, TYPE_MEASURE, name)
            ?? throw Unresolved(reportName, $"measure '{item}' on '{from.Name}'");
        string? agg = m.Agg();
        // Table C: a count is never null; any other measure is not null when it has a @default.
        bool required = (!m.IsRatio() && agg == AGG_COUNT) || m.DefaultValue() is not null;
        if (m.IsRatio())
            return new ReportField(name, ReportFieldRole.Measure, FIELD_SUBTYPE_DECIMAL, required, Measure: m);
        if (agg == AGG_COUNT)
            return new ReportField(name, ReportFieldRole.Measure, FIELD_SUBTYPE_LONG, required, Measure: m);
        var of = ResolveReportingFieldRef(m.OfColumns().FirstOrDefault() ?? "", ReportingMemberOwner(m, from), root, from)
            ?? throw Unresolved(reportName, $"measure '{name}' @of");
        string src = of.SubType;
        if (agg == AGG_SUM)
        {
            if (src == FIELD_SUBTYPE_CURRENCY)
                return new ReportField(name, ReportFieldRole.Measure, FIELD_SUBTYPE_CURRENCY, required, of, Measure: m);
            string sumType = SumLong.Contains(src) ? FIELD_SUBTYPE_LONG
                : Floating.Contains(src) ? FIELD_SUBTYPE_DOUBLE
                : FIELD_SUBTYPE_DECIMAL;
            return new ReportField(name, ReportFieldRole.Measure, sumType, required, Measure: m);
        }
        if (agg == AGG_AVG)
        {
            string avgType = Floating.Contains(src) ? FIELD_SUBTYPE_DOUBLE : FIELD_SUBTYPE_DECIMAL;
            return new ReportField(name, ReportFieldRole.Measure, avgType, required, Measure: m);
        }
        // min / max keep the source field's type.
        return new ReportField(name, ReportFieldRole.Measure, src, required, of, Measure: m);
    }

    /// <summary>
    /// Table B, with Table C's <c>required</c>. Throws <see cref="InvalidOperationException"/>
    /// naming the report when a reference does not resolve (a report that passed the loader's
    /// report validation always resolves).
    /// </summary>
    public static ReportShape Of(MetaObject report, MetaRoot root)
    {
        string fromName = ReportAccessors.ReportFrom(report) ?? throw Unresolved(report.Name, "@from");
        var from = NamingRefs.ResolveObjectRef(root, fromName, NamingRefs.EffectivePackage(report)) as MetaObject
            ?? throw Unresolved(report.Name, $"@from '{fromName}'");
        string[]? spine = ReportSpineHops(report, from, root);
        var fields = new List<ReportField>();
        foreach (var item in ReportAccessors.ReportDimensionItems(report))
            fields.Add(DimensionField(item, from, root, report.Name, spine));
        foreach (string item in ReportAccessors.ReportMeasureNames(report))
            fields.Add(MeasureField(item, report, from, root));
        return new ReportShape(report, from, fields.AsReadOnly());
    }

    /// <summary>
    /// The source a report is READ from: its own read-only source with <c>@role: primary</c>,
    /// else its first own read-only source; null when it declares none (Table A: not lowered).
    /// The same rule that names the lowered view in the TypeScript lowering, so a reader
    /// lands on the relation the lowering created.
    /// </summary>
    public static MetaSource? ReadSource(MetaObject report)
    {
        // ADR-0039: own — source classification reads the sources the report declares
        // ITSELF, exactly as the lowering's view-name rule does.
        var readOnly = report.OwnSources().Where(s => s.IsReadOnly()).ToList();
        return readOnly.FirstOrDefault(s => s.Role == SOURCE_ROLE_PRIMARY) ?? readOnly.FirstOrDefault();
    }

    // -----------------------------------------------------------------------
    // The conformance artifact (fixtures/persistence-conformance/report-shapes.json)
    // -----------------------------------------------------------------------

    /// <summary>
    /// The report-shapes artifact for a loaded model: every <c>object.report</c> in
    /// declaration order, serialised byte for byte as the TypeScript generator
    /// (<c>integration-tests/src/gen-report-shapes.ts</c>) writes it — keys in a fixed
    /// order, two-space indent, every object expanded, one trailing newline.
    /// </summary>
    public static string ToArtifactJson(MetaRoot root)
    {
        var reports = root.Objects().Where(o => o.IsReport()).ToList();
        var sb = new StringBuilder();
        sb.Append("{\n  \"reports\": ");
        if (reports.Count == 0)
        {
            sb.Append("[]");
        }
        else
        {
            sb.Append("[\n");
            for (int i = 0; i < reports.Count; i++)
            {
                AppendReport(sb, Of(reports[i], root));
                sb.Append(i < reports.Count - 1 ? ",\n" : "\n");
            }
            sb.Append("  ]");
        }
        sb.Append("\n}\n");
        return sb.ToString();
    }

    private static void AppendReport(StringBuilder sb, ReportShape shape)
    {
        sb.Append("    {\n");
        sb.Append("      \"report\": ").Append(JsonString(shape.Report.ResolutionKey())).Append(",\n");
        sb.Append("      \"from\": ").Append(JsonString(shape.From.ResolutionKey())).Append(",\n");
        sb.Append("      \"view\": ").Append(JsonStringOrNull(ReadSource(shape.Report)?.PhysicalName)).Append(",\n");
        sb.Append("      \"fields\": ");
        if (shape.Fields.Count == 0)
        {
            sb.Append("[]\n");
        }
        else
        {
            sb.Append("[\n");
            for (int i = 0; i < shape.Fields.Count; i++)
            {
                var f = shape.Fields[i];
                sb.Append("        {\n");
                sb.Append("          \"name\": ").Append(JsonString(f.Name)).Append(",\n");
                sb.Append("          \"role\": ").Append(JsonString(RoleName(f.Role))).Append(",\n");
                sb.Append("          \"subType\": ").Append(JsonString(f.SubType)).Append(",\n");
                sb.Append("          \"required\": ").Append(f.Required ? "true" : "false").Append(",\n");
                sb.Append("          \"typeSource\": ").Append(JsonStringOrNull(TypeSourceKey(f.TypeSource))).Append('\n');
                sb.Append(i < shape.Fields.Count - 1 ? "        },\n" : "        }\n");
            }
            sb.Append("      ]\n");
        }
        sb.Append("    }");
    }

    /// <summary>The wire name of a role, as the artifact spells it.</summary>
    public static string RoleName(ReportFieldRole role) =>
        role == ReportFieldRole.Dimension ? "dimension" : "measure";

    // `<resolutionKey of the entity that DECLARES the field>.<field name>`, or null.
    private static string? TypeSourceKey(MetaField? field)
    {
        if (field is null) return null;
        var owner = field.Parent
            ?? throw new InvalidOperationException($"field '{field.Name}' has no owning entity.");
        return $"{owner.ResolutionKey()}{CHILD_REF_SEPARATOR}{field.Name}";
    }

    private static string JsonStringOrNull(string? s) => s is null ? "null" : JsonString(s);

    // JSON.stringify's string escaping: `"`, `\`, the short escapes, and \u00XX for the
    // remaining control characters. Everything else is written as is.
    private static string JsonString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
