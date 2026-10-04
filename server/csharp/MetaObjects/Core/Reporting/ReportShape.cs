// A report's derived fields (FR-044, contract Table B): one field per `@dimensions` item
// in listed order, then one per `@measures` item in listed order.
//
// Ported rule for rule from
// server/typescript/packages/metadata/src/core/reporting/report-shape.ts, and gated
// against it by fixtures/persistence-conformance/report-shapes.json (the TS-produced
// artifact every port byte-matches; see ReportShapeTests).

using System.Text;
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

    /// <summary>Resolve a dimension's or measure's <c>Entity.field</c> reference to the field node.</summary>
    public static MetaField? ResolveReportingFieldRef(string reference, MetaObject owner, MetaRoot root)
    {
        // `Entity.field`; a package qualifier uses `::`, so the member separator is the LAST dot.
        int dot = reference.LastIndexOf(CHILD_REF_SEPARATOR, StringComparison.Ordinal);
        if (dot <= 0) return null;
        var entity = NamingRefs.ResolveObjectRef(root, reference[..dot], NamingRefs.EffectivePackage(owner)) as MetaObject;
        // ADR-0039: resolving, so a field inherited through extends is found.
        return entity?.FindField(reference[(dot + CHILD_REF_SEPARATOR.Length)..]);
    }

    private static InvalidOperationException Unresolved(string reportName, string what) =>
        new($"report '{reportName}': {what} does not resolve.");

    private static T? DeclaredMember<T>(MetaObject from, string type, string name) where T : MetaData =>
        // ADR-0039: resolving Children(), so a member declared on an abstract base is found.
        from.Children().OfType<T>().FirstOrDefault(c => c.Type == type && c.Name == name);

    private static ReportField DimensionField(ReportDimensionItem item, MetaObject from, MetaRoot root, string reportName)
    {
        var dim = DeclaredMember<MetaDimension>(from, TYPE_DIMENSION, item.Name)
            ?? throw Unresolved(reportName, $"dimension '{item.Name}' on '{from.Name}'");
        var of = ResolveReportingFieldRef(dim.Of() ?? "", from, root)
            ?? throw Unresolved(reportName, $"dimension '{item.Name}' @of");
        string name = ReportAccessors.ReportDerivedFieldName(item);
        // The @required ATTR only, read resolving (ADR-0039); a validator.required child does not count.
        bool required = dim.Via() is null && of.Attr(FIELD_ATTR_REQUIRED) is true;
        if (dim.IsTime())
        {
            return item.Grain == GRAIN_HOUR
                ? new ReportField(name, ReportFieldRole.Dimension, FIELD_SUBTYPE_TIMESTAMP, required, of, dim, item.Grain)
                : new ReportField(name, ReportFieldRole.Dimension, FIELD_SUBTYPE_DATE, required, null, dim, item.Grain);
        }
        return new ReportField(name, ReportFieldRole.Dimension, of.SubType, required, of, dim);
    }

    private static ReportField MeasureField(string name, MetaObject from, MetaRoot root, string reportName)
    {
        var m = DeclaredMember<MetaMeasure>(from, TYPE_MEASURE, name)
            ?? throw Unresolved(reportName, $"measure '{name}' on '{from.Name}'");
        if (m.IsRatio())
            return new ReportField(name, ReportFieldRole.Measure, FIELD_SUBTYPE_DECIMAL, false, Measure: m);
        string? agg = m.Agg();
        if (agg == AGG_COUNT)
            return new ReportField(name, ReportFieldRole.Measure, FIELD_SUBTYPE_LONG, true, Measure: m);
        var of = ResolveReportingFieldRef(m.OfColumns().FirstOrDefault() ?? "", from, root)
            ?? throw Unresolved(reportName, $"measure '{name}' @of");
        string src = of.SubType;
        if (agg == AGG_SUM)
        {
            if (src == FIELD_SUBTYPE_CURRENCY)
                return new ReportField(name, ReportFieldRole.Measure, FIELD_SUBTYPE_CURRENCY, false, of, Measure: m);
            string sumType = SumLong.Contains(src) ? FIELD_SUBTYPE_LONG
                : Floating.Contains(src) ? FIELD_SUBTYPE_DOUBLE
                : FIELD_SUBTYPE_DECIMAL;
            return new ReportField(name, ReportFieldRole.Measure, sumType, false, Measure: m);
        }
        if (agg == AGG_AVG)
        {
            string avgType = Floating.Contains(src) ? FIELD_SUBTYPE_DOUBLE : FIELD_SUBTYPE_DECIMAL;
            return new ReportField(name, ReportFieldRole.Measure, avgType, false, Measure: m);
        }
        // min / max keep the source field's type.
        return new ReportField(name, ReportFieldRole.Measure, src, false, of, Measure: m);
    }

    /// <summary>
    /// Table B. Throws <see cref="InvalidOperationException"/> naming the report when a
    /// reference does not resolve (a report that passed the loader's report validation
    /// always resolves).
    /// </summary>
    public static ReportShape Of(MetaObject report, MetaRoot root)
    {
        string fromName = ReportAccessors.ReportFrom(report) ?? throw Unresolved(report.Name, "@from");
        var from = NamingRefs.ResolveObjectRef(root, fromName, NamingRefs.EffectivePackage(report)) as MetaObject
            ?? throw Unresolved(report.Name, $"@from '{fromName}'");
        var fields = new List<ReportField>();
        foreach (var item in ReportAccessors.ReportDimensionItems(report))
            fields.Add(DimensionField(item, from, root, report.Name));
        foreach (string name in ReportAccessors.ReportMeasureNames(report))
            fields.Add(MeasureField(name, from, root, report.Name));
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
