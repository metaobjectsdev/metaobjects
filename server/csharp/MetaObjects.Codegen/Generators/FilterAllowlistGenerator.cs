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

        return new EmittedFile(OutputPaths.Of(entity, ctx, $"{cls}FilterAllowlist.g.cs"), w.ToString());
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
    }

    /// <summary>The XML doc on the allowlist class.</summary>
    protected virtual void WriteTypeDoc(CsWriter w, string cls) => w.DocSummary(
        $"GENERATED — per-entity FR-009 filter allowlist for {cls}.",
        "<see cref=\"Fields\"/> lists the filterable field names; <see cref=\"OpsByField\"/>",
        "constrains the operator vocabulary for each field by its subtype.");

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
    protected virtual Dictionary<string, IReadOnlyList<string>> ComputeFilterableOps(MetaObject entity)
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
