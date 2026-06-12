// SP-G Registry Conformance — the C# registry-manifest emitter.
//
// Walks an assembled TypeRegistry and serializes the LOGICAL metamodel
// vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This must
// byte-match the single committed canonical produced by the TS reference
// emitter (server/typescript/packages/metadata/src/registry-manifest.ts) — a
// structural gate against the SP-C class of silent vocabulary drift.
//
// The IN/OUT boundary (the v1 logical subset emittable byte-identically by all
// five ports) is documented in fixtures/registry-conformance/README.md. In
// short: type.subType + attrs[{name, valueType, required}] + commonAttrs +
// defaultSubTypes. EXCLUDED from v1 (per-port-physical or not-universally-
// tracked-on-the-registry): factories/native bindings; AttrSchema.Default and
// AllowedValues; declared parent (inheritsFrom); childRules.

using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using MetaObjects.Core.Attr;
using MetaObjects.Core.Documentation;
using MetaObjects.Presentation.View;
using MetaObjects.Shared;

namespace MetaObjects;

/// <summary>
/// Emits the canonical registry manifest (the SP-G cross-port logical-vocabulary
/// contract) as a byte-stable JSON string. Mirrors the TS reference emitter
/// <c>emitRegistryManifest</c> exactly.
/// </summary>
public static class RegistryManifest
{
    // ------------------------------------------------------------------
    // SP-G Phase1 Units2-3 — manifest emitter exclusions (documented, uniform
    // across all four ports; see fixtures/registry-conformance/README.md
    // "EXCLUDED" list + the SP-G divergence analysis buckets C-2/C-3/C-5/B-2):
    //  - structural keywords (`isArray`/`isAbstract`) + the `description`
    //    commonAttr are NOT per-type attrs (no-op for C#, which never registers
    //    them as such; `description` stays in commonAttrs);
    //  - `metadata.base` is a per-port inheritance anchor (Java's), not in the
    //    cross-port contract — other ports register only `metadata.root`;
    //  - the 11 generic `view.*` controls are a TS-web-presentation facet (cut
    //    cross-port; C#/Python deregister them, TS keeps them registered).
    // ------------------------------------------------------------------

    // Wave 3b — the in/out boundary is an EXPLICIT CLASSIFICATION (a reason
    // category per carve-out), not a bare name-match. The negative branch of a
    // name-list silently meant "logical"; now `ClassifyPerTypeAttr` returns
    // either an ExclusionReason (carved out, with a documented category) or
    // INCLUDED (logical cross-port vocabulary). Inclusion-by-classification is
    // sound because ADR-0023 seals the agreed-vocabulary registry. The axis is
    // cross-port-CONTRACT vs port-PRIVATE-mechanism (NOT abstract-vs-physical —
    // the physical-DB attrs column/dbColumnType/db.indexed/precision/scale/
    // maxLength/unique ARE logical here, the agreed persistence vocabulary).

    /// <summary>The reason a per-type attr/row is classified PORT_PRIVATE (carved out of the agreed vocabulary).</summary>
    public enum ExclusionReason
    {
        /// <summary>Sentinel: NOT excluded — logical cross-port vocabulary (INCLUDED).</summary>
        Included,
        /// <summary>Native type-binding / factory mechanism (incl. ADR-0001 <c>object</c>, ADR-0005 <c>objectAdapter</c>).</summary>
        NativeBinding,
        /// <summary>Bare structural / OO-shape keyword (<c>isArray</c>/<c>isAbstract</c>/<c>extends</c>/<c>implements</c>/<c>isInterface</c>).</summary>
        StructuralKeyword,
        /// <summary>A <c>commonAttr</c> (<c>description</c>) re-registered per-type — belongs in the commonAttrs block.</summary>
        CommonAttrDup,
        /// <summary>The <c>metadata.base</c> per-port inheritance anchor (deferred <c>inheritsFrom</c> facet).</summary>
        InheritanceAnchor,
        /// <summary>TS-web-presentation-only facet (the generic <c>view.*</c> controls).</summary>
        PresentationOnly,
        /// <summary>
        /// FR-024 vocabulary registered ahead of the cross-port manifest; atomic
        /// all-ports manifest flip in FR-024 Phase E. The TS-reference-first rollout
        /// pattern: the new vocabulary is genuinely registered (and gated by this
        /// port's tests) but carved out of the cross-port manifest until every port
        /// registers it, then the carve-out is removed and the canonical updated in
        /// ONE commit (the same lifecycle the retired TsPilotVocab carve-outs
        /// followed for <c>@responseRef</c>/<c>@provided</c>).
        /// Members today: the <c>object.projection</c> (type, subType) row (ADR-0028).
        /// </summary>
        Fr024Pending,
    }

    /// <summary>`isAbstract` as the per-type attr name (the contract's bare `abstract` structural keyword).</summary>
    private const string AttrNameIsAbstract = "isAbstract";
    /// <summary>The Java-OO structural-shape keyword names (the OO modeling spine), not cross-port per-type attrs.</summary>
    private const string AttrNameImplements = "implements";
    private const string AttrNameIsInterface = "isInterface";
    /// <summary>ADR-0001 class-FQN type binding + ADR-0005 hybrid value-access seam (per-port runtime mechanisms).</summary>
    private const string AttrNameObject = "object";
    private const string AttrNameObjectAdapter = "objectAdapter";

    /// <summary>Per-type attr names carved out of the agreed vocabulary, each mapped to its PORT_PRIVATE reason. An attr NOT in this map is logical (INCLUDED) by the ADR-0023 sealed-vocabulary contract.</summary>
    private static readonly IReadOnlyDictionary<string, ExclusionReason> ExcludedPerTypeAttrs =
        new Dictionary<string, ExclusionReason>(StringComparer.Ordinal)
        {
            [Structural.RESERVED_KEY_IS_ARRAY] = ExclusionReason.StructuralKeyword,
            [AttrNameIsAbstract] = ExclusionReason.StructuralKeyword,
            [Structural.RESERVED_KEY_EXTENDS] = ExclusionReason.StructuralKeyword,
            [AttrNameImplements] = ExclusionReason.StructuralKeyword,
            [AttrNameIsInterface] = ExclusionReason.StructuralKeyword,
            [AttrNameObject] = ExclusionReason.NativeBinding,
            [AttrNameObjectAdapter] = ExclusionReason.NativeBinding,
            [DocumentationConstants.DOC_ATTR_DESCRIPTION] = ExclusionReason.CommonAttrDup,
        };

    /// <summary>Classify a per-type attr: an <see cref="ExclusionReason"/> (carved out) or <see cref="ExclusionReason.Included"/> (logical). Total — no silent default.</summary>
    public static ExclusionReason ClassifyPerTypeAttr(string name) =>
        ExcludedPerTypeAttrs.TryGetValue(name, out ExclusionReason reason) ? reason : ExclusionReason.Included;

    /// <summary>Classify a <c>(type, subType)</c> row: the metadata.base inheritance anchor / the generic view.* presentation controls / Included.</summary>
    public static ExclusionReason ClassifyTypeSubType(string type, string subType)
    {
        if (type == BaseTypes.TYPE_METADATA && subType == BaseTypes.SUBTYPE_BASE)
        {
            return ExclusionReason.InheritanceAnchor; // C-5 — Java's internal inheritance anchor
        }
        if (type == BaseTypes.TYPE_VIEW
            && subType != BaseTypes.SUBTYPE_BASE
            && subType != ViewConstants.VIEW_SUBTYPE_CURRENCY)
        {
            return ExclusionReason.PresentationOnly; // B-2 — TS-web-presentation generic view controls
        }
        if (type == BaseTypes.TYPE_OBJECT && subType == Core.Object.ObjectConstants.OBJECT_SUBTYPE_PROJECTION)
        {
            // FR-024 vocabulary registered ahead of the cross-port manifest; atomic
            // all-ports manifest flip in FR-024 Phase E.
            return ExclusionReason.Fr024Pending;
        }
        return ExclusionReason.Included;
    }

    /// <summary>
    /// FR-024-pending manifest REQUIREDNESS overrides (the attr-level analogue of
    /// the <see cref="ExclusionReason.Fr024Pending"/> row carve-out). Key is
    /// <c>"type.subType.attrName"</c>; value is the requiredness the cross-port
    /// canonical (<c>expected-registry.json</c>) still records. This port's registry
    /// already registers the FR-024 requiredness, but not every port has flipped
    /// yet — the manifest keeps emitting the pre-FR-024 agreed value so the shared
    /// canonical stays byte-identical until the Phase-E atomic all-ports flip, when
    /// this map empties and the canonical is updated in ONE commit.
    ///
    /// Members today: <c>origin.aggregate.via</c> — required pre-FR-024; OPTIONAL
    /// under ADR-0029 decision 5 (omitted <c>@via</c> is inferred when exactly one
    /// single-hop relationship leads from the base entity to the <c>@of</c> entity).
    /// </summary>
    private static readonly IReadOnlyDictionary<string, bool> Fr024PendingRequiredOverrides =
        new Dictionary<string, bool>(StringComparer.Ordinal)
        {
            [$"{BaseTypes.TYPE_ORIGIN}.{Persistence.Origin.OriginConstants.ORIGIN_SUBTYPE_AGGREGATE}.{Persistence.Origin.OriginConstants.ORIGIN_AGGREGATE_ATTR_VIA}"] = true,
        };

    /// <summary>Manifest requiredness for an attr — the FR-024-pending override when one exists, else null.</summary>
    public static bool? ManifestRequiredOverride(string type, string subType, string attrName) =>
        Fr024PendingRequiredOverrides.TryGetValue($"{type}.{subType}.{attrName}", out bool required)
            ? required
            : null;

    /// <summary>True if a <c>(type, subType)</c> row is carved out of the manifest (any reason).</summary>
    private static bool IsExcludedTypeSubType(string type, string subType) =>
        ClassifyTypeSubType(type, subType) != ExclusionReason.Included;

    // ------------------------------------------------------------------
    // Manifest shape — explicit ordered structures so JSON property order is
    // fixed by construction (insertion order), never reflection-dependent.
    // ------------------------------------------------------------------

    /// <summary>One attribute in the manifest — the logical, cross-port-identical facet.</summary>
    private sealed record ManifestAttr(string Name, string? ValueType, bool IsArray, bool Required);

    /// <summary>One registered (type, subType) with its declared attrs.</summary>
    private sealed record ManifestType(string Type, string SubType, IReadOnlyList<ManifestAttr> Attrs);

    // ------------------------------------------------------------------
    // Build
    // ------------------------------------------------------------------

    /// <summary>
    /// Build the canonical manifest as ordered, sorted collections.
    /// All collections are sorted by ordinal (locale-independent) string compare
    /// for byte-stability across ports.
    /// </summary>
    private static (List<ManifestType> Types, List<ManifestAttr> CommonAttrs, SortedDictionary<string, string> DefaultSubTypes)
        Build(TypeRegistry registry)
    {
        List<ManifestType> types = registry
            .AllTypes()
            .Where(typeId => !IsExcludedTypeSubType(typeId.Type, typeId.SubType))
            .Select(typeId => new ManifestType(
                typeId.Type,
                typeId.SubType,
                SortedPerTypeAttrs(registry.AttrsOf(typeId.Type, typeId.SubType), typeId.Type, typeId.SubType)))
            .OrderBy(t => $"{t.Type}.{t.SubType}", StringComparer.Ordinal)
            .ToList();

        List<ManifestAttr> commonAttrs = SortedAttrs(registry.GetCommonAttrs());

        // defaultSubTypes: derive candidate type names from the registered types,
        // probe each, and key into a SortedDictionary (ordinal) for stable order.
        SortedDictionary<string, string> defaultSubTypes = new(StringComparer.Ordinal);
        foreach (string typeName in types.Select(t => t.Type).Distinct())
        {
            string? defaultSub = registry.DefaultSubTypeOf(typeName);
            if (defaultSub is not null)
            {
                defaultSubTypes[typeName] = defaultSub;
            }
        }

        return (types, commonAttrs, defaultSubTypes);
    }

    /// <summary>
    /// Normalize + sort attr schemas to the manifest's logical attr shape (by name, ordinal),
    /// decomposing array-ness into a scalar <c>valueType</c> + an orthogonal <c>isArray</c> flag.
    /// A legacy <c>stringarray</c> valueType token is also decomposed to
    /// <c>{ valueType: "string", isArray: true }</c> so no <c>stringarray</c> token reaches the manifest.
    /// </summary>
    private static List<ManifestAttr> SortedAttrs(IReadOnlyList<AttrSchema> attrs) =>
        attrs
            .Select(ToManifestAttr)
            .OrderBy(a => a.Name, StringComparer.Ordinal)
            .ToList();

    /// <summary>
    /// As <see cref="SortedAttrs"/>, but keeping only attrs the explicit
    /// classification marks <see cref="ExclusionReason.Included"/> (logical
    /// cross-port vocabulary). A carved-out attr (structural keyword, native
    /// binding, per-type <c>description</c> dup) is dropped for a documented
    /// reason, never a silent name-match. Applied ONLY to per-type attrs —
    /// <c>description</c> stays in the commonAttrs block.
    /// FR-024: an attr in <see cref="Fr024PendingRequiredOverrides"/> keeps
    /// emitting the pre-FR-024 agreed requiredness until the Phase-E atomic flip.
    /// </summary>
    private static List<ManifestAttr> SortedPerTypeAttrs(IReadOnlyList<AttrSchema> attrs, string type, string subType) =>
        SortedAttrs(attrs.Where(a => ClassifyPerTypeAttr(a.Name) == ExclusionReason.Included).ToList())
            .Select(attr =>
            {
                bool? required = ManifestRequiredOverride(type, subType, attr.Name);
                return required is null ? attr : attr with { Required = required.Value };
            })
            .ToList();

    private static ManifestAttr ToManifestAttr(AttrSchema a)
    {
        bool isLegacyStringArray = a.ValueType == AttrConstants.ATTR_SUBTYPE_STRINGARRAY;
        bool isArray = a.IsArray || isLegacyStringArray;
        string? valueType = isLegacyStringArray ? AttrConstants.ATTR_SUBTYPE_STRING : a.ValueType;
        return new ManifestAttr(a.Name, valueType, isArray, a.Required);
    }

    // ------------------------------------------------------------------
    // Emit
    // ------------------------------------------------------------------

    /// <summary>
    /// Emit the canonical registry manifest as a byte-stable JSON string.
    ///
    /// Serialization contract — every port MUST match this exactly:
    ///  - 2-space indentation.
    ///  - Object key order fixed by construction: <c>types</c>, <c>commonAttrs</c>,
    ///    <c>defaultSubTypes</c>; each type as <c>type</c>, <c>subType</c>, <c>attrs</c>;
    ///    each attr as <c>name</c>, <c>valueType</c>, <c>isArray</c>, <c>required</c>.
    ///  - All arrays sorted (ordinal/ASCII): types by "type.subType"; attrs by name;
    ///    commonAttrs by name; defaultSubTypes keys sorted.
    ///  - <c>valueType: null</c> literal for polymorphic/untyped attrs.
    ///  - A single trailing newline.
    /// </summary>
    public static string Emit(TypeRegistry registry)
    {
        (List<ManifestType> types, List<ManifestAttr> commonAttrs, SortedDictionary<string, string> defaultSubTypes) =
            Build(registry);

        // Hand-roll via Utf8JsonWriter against an ordered model so property order
        // is guaranteed and never reflection/anonymous-type dependent.
        using var stream = new MemoryStream();
        var writerOptions = new JsonWriterOptions
        {
            Indented = true,
            // Match plain JSON: do not \uXXXX-escape '+', '&', '<', '>' etc. so
            // the bytes line up with the TS JSON.stringify reference output.
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        using (var writer = new Utf8JsonWriter(stream, writerOptions))
        {
            writer.WriteStartObject();

            // types
            writer.WriteStartArray("types");
            foreach (ManifestType t in types)
            {
                writer.WriteStartObject();
                writer.WriteString("type", t.Type);
                writer.WriteString("subType", t.SubType);
                writer.WriteStartArray("attrs");
                foreach (ManifestAttr a in t.Attrs)
                {
                    WriteAttr(writer, a);
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();

            // commonAttrs
            writer.WriteStartArray("commonAttrs");
            foreach (ManifestAttr a in commonAttrs)
            {
                WriteAttr(writer, a);
            }
            writer.WriteEndArray();

            // defaultSubTypes
            writer.WriteStartObject("defaultSubTypes");
            foreach (KeyValuePair<string, string> kv in defaultSubTypes)
            {
                writer.WriteString(kv.Key, kv.Value);
            }
            writer.WriteEndObject();

            writer.WriteEndObject();
        }

        string json = Encoding.UTF8.GetString(stream.ToArray());
        // Utf8JsonWriter indents with 2 spaces and "\n" newlines (no trailing
        // newline). Append the single trailing newline the canonical carries.
        return json + "\n";
    }

    private static void WriteAttr(Utf8JsonWriter writer, ManifestAttr a)
    {
        writer.WriteStartObject();
        writer.WriteString("name", a.Name);
        if (a.ValueType is null)
        {
            writer.WriteNull("valueType");
        }
        else
        {
            writer.WriteString("valueType", a.ValueType);
        }
        writer.WriteBoolean("isArray", a.IsArray);
        writer.WriteBoolean("required", a.Required);
        writer.WriteEndObject();
    }
}
