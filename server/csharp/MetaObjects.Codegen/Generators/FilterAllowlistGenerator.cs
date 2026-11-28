// filter-allowlist-generator — emits one <Entity>FilterAllowlist.cs per writable
// object.entity that lists filterable field names + the per-field operator
// allowlist (per the cross-port FR-009 spec).
//
// Authoring contract: only fields with @filterable: true appear in the
// allowlist. If no field is marked filterable the file is still emitted (with
// empty collections) so the generated routes can unconditionally delegate to
// it without conditional codegen branching.
//
// Operators-per-subtype mapping (FR-009 §5, identical across ports):
//   string / enum                              → eq, ne, in, like, isNull
//   uuid                                       → eq, ne, in, isNull  (no like — not a substring type)
//   int / long / float / double /
//   decimal / currency / date / timestamp / time → eq, ne, gt, gte, lt, lte, in, isNull
//   boolean                                    → eq, isNull
//
// A view-backed `object.report` (FR-044) gets one too, from its row model: every derived
// field with a filter band is filterable (ReportRows). A report with no view source gets none.

using MetaObjects.Codegen.Writer;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>Generates one <c>&lt;Entity&gt;FilterAllowlist.cs</c> per writable entity.</summary>
public class FilterAllowlistGenerator : PerEntityGenerator
{
    public override string Name => "filter-allowlist-generator";

    // Where the emitted allowlist imports FilterFieldRule / SortFieldRule from. `dotnet meta eject`
    // rewrites this one line to "Codegen.Runtime" and copies the helpers into codegen/runtime/.
    private const string HelperRuntimeNamespace = "MetaObjects.AspNetCore";

    public override bool Filter(MetaObject entity) => AppliesTo(entity);

    /// <summary>
    /// True iff this entity gets a generated filter allowlist: any persisted,
    /// instance-emitting read surface — including a read-only projection. Single source
    /// of truth shared by the generator loop AND the api-docs builder.
    /// <para>
    /// Deliberately the same predicate as <see cref="RoutesGenerator.Filter"/>, because
    /// the routes file NAMES <c>&lt;Cls&gt;FilterAllowlist</c> and the two must pick the
    /// same entities or the emitted tree does not compile. This used to carry an extra
    /// <c>!IsReadOnlyProjection()</c> on the rationale that projections had no filter
    /// routes — which had stopped being true: a projection's list route emits the same
    /// <c>FilterParser.Parse</c> line as any other read. The skip did not disable
    /// filtering, it left a dangling reference, and `gen` still exited 0. Note the TPH
    /// subtypes stay IN (unlike <see cref="RoutesGenerator.AppliesTo"/>, which excludes
    /// them from having their own routes FILE): the base's routes file references a
    /// per-subtype allowlist for each of them.
    /// </para>
    /// <para>
    /// Also a sourceless entity (<see cref="InstanceArtifacts.IsSourcelessEntity"/>): no
    /// routes, but an allowlist for the list endpoint its adopter writes over a store
    /// MetaObjects does not manage. Nothing generated references it.
    /// </para>
    /// </summary>
    public static bool AppliesTo(MetaObject entity) =>
        // FR-044 — a report applies iff it is served, the same answer RoutesGenerator.AppliesTo
        // gives, and for the same reason the two predicates agree everywhere else: the routes
        // file names this allowlist. True for the declared node and for its row model alike.
        entity.IsReport()
            ? ReportRows.IsViewBacked(entity)
            : ((entity.IsEntity() || entity.DbView is not null)
                    && InstanceArtifacts.EmitsInstanceArtifacts(entity))
                || InstanceArtifacts.IsSourcelessEntity(entity);

    // FR-044 — a served report joins the set as its ROW MODEL (ReportRows), whose derived
    // fields are what the allowlist lists; a raw report node in the entity set is dropped.
    public override IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ReportRows.WithReportRows(ctx.Narrow(Include)).Where(Filter).Select(e => GenerateOne(e, ctx));

    protected override EmittedFile GenerateOne(MetaObject entity, GenContext ctx)
    {
        var cls = CSharpNaming.Pascal(entity.Name);
        var filterClass = CSharpNaming.FilterAllowlistName(entity);
        var hierarchyCredentials = TphPlanBuilder.HierarchyCredentialNames(entity, ctx.Root);
        var opsByField = ComputeFilterableOps(entity)
            .Where(kv => !hierarchyCredentials.Contains(kv.Key))
            .ToDictionary(kv => kv.Key, kv => kv.Value, System.StringComparer.Ordinal);
        // In its entity's namespace when package namespaces are on (as <Entity>Names is), so mapping
        // the packages apart separates the allowlists too; claimed where it is emitted.
        var ns = ValueObjectNames.CompanionNamespace(entity, ctx.Config);
        ctx.Claim($"the C# namespace {ns}", filterClass, entity.ResolutionKey(),
            "map the packages to distinct namespaces (csharp.packageNamespaces, or GenConfig.PackageNamespaces), or rename one");

        var w = NewWriter();
        WriteFileHeader(w);
        w.Blank();
        w.Line($"namespace {ns};");
        w.Blank();
        WriteTypeDoc(w, cls);
        using (w.Braced($"public static class {filterClass}"))
        {
            WriteFields(w, opsByField);
            w.Blank();
            WriteOpsByField(w, opsByField);
            w.Blank();
            WriteRules(w, RulesFrom(entity, opsByField));
            w.Blank();
            WriteSortRules(w, SortRules(entity, ctx.Root));
            w.Blank();
            WriteFieldNames(w, FieldNames(entity, ctx.Root));
            // The field -> CLR property map, only when a property-naming resolver renamed a property
            // beyond case (the runtime matches a field to its property case-insensitively, which
            // covers every other spelling). Nothing is emitted otherwise, so default output is unchanged.
            var renamed = CSharpNaming.RenamedProperties(entity, ctx.Config);
            if (renamed.Count > 0)
            {
                w.Blank();
                WritePropertyByField(w, renamed);
            }
        }

        return new EmittedFile(OutputPaths.Of(entity, ctx, $"{cls}FilterAllowlist.g.cs"), w.ToString()) { SourceNode = entity.ResolutionKey() };
    }

    // The pieces of the file, one overridable method each (ADR-0063 item 7): a subclass changes the
    // piece it wants and keeps the rest. Not a stability contract.

    /// <summary>The writer the file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();

    /// <summary>The generated-file marker, the generator's name, the nullable context and the usings.</summary>
    protected virtual void WriteFileHeader(CsWriter w)
    {
        w.GeneratedFileHeader("filter-allowlist-generator");
        w.Using("System.Collections.Generic");
        w.Using(HelperRuntimeNamespace);
    }

    /// <summary>The XML doc on the allowlist class.</summary>
    protected virtual void WriteTypeDoc(CsWriter w, string cls) => w.DocSummary(
        $"GENERATED — per-entity FR-009 filter allowlist for {cls}.",
        "<see cref=\"Fields\"/> lists the filterable field names; <see cref=\"OpsByField\"/>",
        "constrains the operator vocabulary for each field by its subtype.",
        "<see cref=\"Rules\"/>, <see cref=\"Sort\"/> and <see cref=\"FieldNames\"/> are what",
        "<c>ListQueryParser</c> reads a list route's query string against.");

    /// <summary>The <c>Fields</c> set: the filterable field names. Ordinal comparison, because the URL grammar is case-exact.</summary>
    protected virtual void WriteFields(CsWriter w, IReadOnlyDictionary<string, IReadOnlyList<string>> opsByField)
    {
        using (w.Braced("public static readonly HashSet<string> Fields = new(System.StringComparer.Ordinal)", "};"))
        {
            foreach (var f in opsByField.Keys) w.Line($"\"{f}\",");
        }
    }

    /// <summary>The <c>OpsByField</c> dictionary: each field's operator set.</summary>
    protected virtual void WriteOpsByField(CsWriter w, IReadOnlyDictionary<string, IReadOnlyList<string>> opsByField)
    {
        using (w.Braced("public static readonly Dictionary<string, HashSet<string>> OpsByField = new(System.StringComparer.Ordinal)", "};"))
        {
            foreach (var (field, ops) in opsByField)
                w.Line($"[\"{field}\"] = new(System.StringComparer.Ordinal) {{ {string.Join(", ", ops.Select(op => $"\"{op}\""))} }},");
        }
    }

    /// <summary>
    /// The <c>Rules</c> dictionary the list query parser (<c>ListQueryParser</c>) reads: per filterable
    /// field its operators, value kind and value checks.
    /// </summary>
    protected virtual void WriteRules(CsWriter w, IReadOnlyList<(string Field, FilterRuleSpec Rule)> rules)
    {
        w.Line("/// <summary>Each filterable field's rule: its operators, how its values are typed and checked.</summary>");
        using (w.Braced("public static readonly IReadOnlyDictionary<string, FilterFieldRule> Rules = new Dictionary<string, FilterFieldRule>(System.StringComparer.Ordinal)", "};"))
        {
            foreach (var (field, rule) in rules)
            {
                var init = new List<string>();
                if (rule.Format is not null) init.Add($"Format = FilterValueFormats.{CSharpNaming.Pascal(rule.Format)}");
                if (rule.Instant) init.Add("Instant = true");
                if (rule.Integer) init.Add("Integer = true");
                if (rule.EnumValues is not null) init.Add($"EnumValues = new[] {{ {string.Join(", ", rule.EnumValues.Select(m => $"\"{m}\""))} }}");
                var ops = string.Join(", ", rule.Ops.Select(op => $"\"{op}\""));
                var tail = init.Count == 0 ? "" : $" {{ {string.Join(", ", init)} }}";
                w.Line($"[\"{field}\"] = new(FilterValueKind.{rule.Kind}, {ops}){tail},");
            }
        }
    }

    /// <summary>The <c>Sort</c> dictionary: the sortable fields, each with its declared default order.</summary>
    protected virtual void WriteSortRules(CsWriter w, IReadOnlyList<(string Field, string? DefaultOrder)> rules)
    {
        w.Line("/// <summary>The sortable fields, each with its declared <c>@sortableDefaultOrder</c>.</summary>");
        using (w.Braced("public static readonly IReadOnlyDictionary<string, SortFieldRule> Sort = new Dictionary<string, SortFieldRule>(System.StringComparer.Ordinal)", "};"))
        {
            foreach (var (field, order) in rules)
                w.Line(order is null ? $"[\"{field}\"] = new()," : $"[\"{field}\"] = new(\"{order}\"),");
        }
    }

    /// <summary>
    /// The <c>FieldNames</c> set: every field of the entity, so a bare <c>?notes=x</c> for a field that
    /// is not filterable is refused with a reason instead of ignored.
    /// </summary>
    protected virtual void WriteFieldNames(CsWriter w, IReadOnlyList<string> names)
    {
        w.Line("/// <summary>Every field of the entity, filterable or not, except a credential.</summary>");
        using (w.Braced("public static readonly IReadOnlySet<string> FieldNames = new HashSet<string>(System.StringComparer.Ordinal)", "};"))
        {
            foreach (var name in names) w.Line($"\"{name}\",");
        }
    }

    /// <summary>
    /// The names <c>FieldNames</c> lists: every field of <paramref name="entity"/> but a credential
    /// (its own, or a column a sibling TPH subtype marks as one). A bare parameter naming a
    /// credential is ignored like any unknown parameter, so the refusal never confirms the column.
    /// </summary>
    public static IReadOnlyList<string> FieldNames(MetaObject entity, MetaRoot root)
    {
        var hierarchyCredentials = TphPlanBuilder.HierarchyCredentialNames(entity, root);
        return entity.Fields()
            .Where(f => !InstanceArtifacts.IsCredentialField(f) && !hierarchyCredentials.Contains(f.Name))
            .Select(f => f.Name).ToList();
    }

    /// <summary>The <c>PropertyByField</c> map, for a field whose CLR property is named beyond case.</summary>
    protected virtual void WritePropertyByField(CsWriter w, IReadOnlyDictionary<string, string> renamed)
    {
        w.Line("/// <summary>The CLR property of each field whose property name is not the field name in another case.</summary>");
        using (w.Braced("public static readonly IReadOnlyDictionary<string, string> PropertyByField = new Dictionary<string, string>(System.StringComparer.Ordinal)", "};"))
        {
            foreach (var (field, property) in renamed) w.Line($"[\"{field}\"] = \"{property}\",");
        }
    }

    /// <summary>
    /// Build the (fieldName → opSet) map for <paramref name="entity"/>. Only
    /// fields with <c>@filterable: true</c> are included; subtypes outside the
    /// FR-009 vocabulary (object/class) collapse to the empty op-set and are
    /// dropped.
    /// </summary>
    protected virtual Dictionary<string, IReadOnlyList<string>> ComputeFilterableOps(MetaObject entity) => ComputeOps(entity);

    private static Dictionary<string, IReadOnlyList<string>> ComputeOps(MetaObject entity)
    {
        var out_ = new Dictionary<string, IReadOnlyList<string>>(System.StringComparer.Ordinal);
        foreach (var field in entity.Fields())
        {
            if (field.SubType == FIELD_SUBTYPE_OBJECT) continue;
            if (!IsFilterable(field)) continue;
            // A credential is never filterable: eq / like on a secret is an oracle for it. Left off
            // the allowlist, an explicit request is refused as any unknown field is.
            if (InstanceArtifacts.IsCredentialField(field)) continue;
            var ops = OpsForField(field);
            if (ops.Count == 0) continue;
            out_[field.Name] = ops;
        }
        return out_;
    }

    /// <summary>
    /// The filter rules of <paramref name="entity"/>, as data: what <c>&lt;Entity&gt;FilterAllowlist.Rules</c>
    /// carries, in field order. The same derivation as TypeScript's <c>filterAllowlistRules</c>, so both
    /// ports hold the shared list-query parse cases. Public so a runner, or an owned generator, derives
    /// the allowlist this one emits.
    /// </summary>
    public static IReadOnlyList<(string Field, FilterRuleSpec Rule)> FilterRules(MetaObject entity, MetaRoot root)
    {
        var hierarchyCredentials = TphPlanBuilder.HierarchyCredentialNames(entity, root);
        return RulesFrom(entity, ComputeOps(entity).Where(kv => !hierarchyCredentials.Contains(kv.Key))
            .ToDictionary(kv => kv.Key, kv => kv.Value, System.StringComparer.Ordinal));
    }

    // Each field of the operator map, with its rule; the map is the generator's (overridable) answer.
    private static IReadOnlyList<(string Field, FilterRuleSpec Rule)> RulesFrom(
        MetaObject entity, IReadOnlyDictionary<string, IReadOnlyList<string>> opsByField)
    {
        var fields = new Dictionary<string, MetaField>(System.StringComparer.Ordinal);
        foreach (var f in entity.Fields()) fields.TryAdd(f.Name, f);
        return opsByField
            .Select(kv => (kv.Key, fields.TryGetValue(kv.Key, out var f) ? RuleFor(f, kv.Value) : new FilterRuleSpec(kv.Value, "String")))
            .ToList();
    }

    /// <summary>
    /// The sortable fields of <paramref name="entity"/> and their declared default order: explicit
    /// <c>@sortable: true</c>, or no <c>@sortable</c> and <c>@filterable: true</c>. Never a credential,
    /// an array, or a field with no scalar column (a value object, a map).
    /// </summary>
    public static IReadOnlyList<(string Field, string? DefaultOrder)> SortRules(MetaObject entity, MetaRoot root)
    {
        var hierarchyCredentials = TphPlanBuilder.HierarchyCredentialNames(entity, root);
        var out_ = new List<(string, string?)>();
        foreach (var f in entity.Fields())
        {
            if (f.SubType is FIELD_SUBTYPE_OBJECT or FIELD_SUBTYPE_MAP || f.ResolvedIsArray()) continue;
            if (InstanceArtifacts.IsCredentialField(f) || hierarchyCredentials.Contains(f.Name)) continue;
            var sortable = AttrBool(f.Attr(FIELD_ATTR_SORTABLE)) ?? IsFilterable(f);
            if (!sortable) continue;
            var order = f.Attr(FIELD_ATTR_SORTABLE_DEFAULT_ORDER) as string;
            out_.Add((f.Name, order is "asc" or "desc" ? order : null));
        }
        return out_;
    }

    private static bool? AttrBool(object? v) => v switch
    {
        bool b => b,
        string s when string.Equals(s, "true", StringComparison.OrdinalIgnoreCase) => true,
        string s when string.Equals(s, "false", StringComparison.OrdinalIgnoreCase) => false,
        _ => null,
    };

    private static readonly HashSet<string> NumberSubtypes = new(System.StringComparer.Ordinal)
    {
        FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
    };

    private static readonly HashSet<string> IntegerSubtypes = new(System.StringComparer.Ordinal)
    {
        FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY,
    };

    private static readonly HashSet<string> FormatSubtypes = new(System.StringComparer.Ordinal)
    {
        FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIME, FIELD_SUBTYPE_TIMESTAMP, FIELD_SUBTYPE_UUID, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_DURATION,
    };

    private static FilterRuleSpec RuleFor(MetaField f, IReadOnlyList<string> ops)
    {
        var kind = f.SubType == FIELD_SUBTYPE_BOOLEAN ? "Boolean"
            : NumberSubtypes.Contains(f.SubType) ? "Number"
            : f.SubType is FIELD_SUBTYPE_DATE or FIELD_SUBTYPE_TIME or FIELD_SUBTYPE_TIMESTAMP ? "Datetime"
            : "String";
        // Value checks hold for a scalar field only: an array field's operand is not one element.
        if (f.ResolvedIsArray()) return new FilterRuleSpec(ops, kind);
        if (IntegerSubtypes.Contains(f.SubType)) return new FilterRuleSpec(ops, kind, Integer: true);
        if (FormatSubtypes.Contains(f.SubType))
            return new FilterRuleSpec(ops, kind, Format: f.SubType, Instant: f.SubType == FIELD_SUBTYPE_TIMESTAMP && !CSharpNaming.IsLocalTime(f));
        if (f.SubType == FIELD_SUBTYPE_ENUM)
        {
            // Member SYMBOLS for string- and int-backed enums alike.
            // ADR-0039: resolving — @values may be inherited from an abstract enum base via extends.
            var members = f.Attr(FIELD_ATTR_VALUES) switch
            {
                IReadOnlyList<string> ss => ss,
                IReadOnlyList<object?> os => os.Select(o => o?.ToString() ?? "").ToList(),
                _ => new List<string>(),
            };
            if (members.Count > 0) return new FilterRuleSpec(ops, kind, EnumValues: members);
        }
        return new FilterRuleSpec(ops, kind);
    }

    /// <summary>True iff <paramref name="field"/> carries <c>@filterable: true</c> (bool true or case-insensitive "true" — matches Java/Kotlin/Python tolerance).</summary>
    // ADR-0039: resolving — @filterable may be inherited via extends (TS reads field.attr).
    private static bool IsFilterable(MetaField field) => field.Attr(FIELD_ATTR_FILTERABLE) switch
    {
        true => true,
        string s => string.Equals(s, "true", StringComparison.OrdinalIgnoreCase),
        _ => false,
    };

    /// <summary>
    /// Operator set for <paramref name="field"/>, or empty for unsupported subtypes.
    /// <para>
    /// Delegates wholesale to <c>QueryConstants.OpsForField</c> — the cross-port single
    /// source of truth, pinned by <c>fixtures/conformance/filter-ops-matrix</c>. This
    /// generator used to carry its OWN copy of the per-subtype band table; that copy was
    /// removed rather than extended, because two tables is exactly how the bands drift.
    /// </para>
    /// <para>
    /// Field-level, not subtype-level: an int-backed <c>field.enum</c>
    /// (<c>@intValueMap</c>, design D5) persists as an INTEGER column, so <c>like</c> —
    /// a substring match — is dropped.
    /// </para>
    /// <para>
    /// Eject (ADR-0034 Amendment 3): public so an owned copy of another generator can
    /// derive the same per-field operator set this one emits into the allowlist, rather
    /// than re-deriving it against <c>QueryConstants</c> directly.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> OpsForField(MetaField field) =>
        MetaObjects.Core.Query.QueryConstants.OpsForField(field);
}

/// <summary>
/// One filterable field's rule as data (the runtime's <c>FilterFieldRule</c>, kept structural so
/// codegen does not depend on the runtime package). <see cref="Kind"/> names a <c>FilterValueKind</c>
/// member; <see cref="Format"/> is the subtype whose wire format values must match.
/// </summary>
public sealed record FilterRuleSpec(
    IReadOnlyList<string> Ops,
    string Kind,
    string? Format = null,
    bool Instant = false,
    bool Integer = false,
    IReadOnlyList<string>? EnumValues = null);
