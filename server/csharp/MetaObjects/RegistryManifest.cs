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
        /// FR-024 reference-first rollout slot (RETIRED at the atomic flip): the
        /// <c>object.projection</c> row + the <c>origin.aggregate.via</c>
        /// required-override were excluded until every port registered the FR-024
        /// loader-grammar slice, then removed with the canonical updated in ONE
        /// commit (the <c>@responseRef</c> carve-out-close playbook). Kept as the
        /// documented lifecycle slot for the next rollout; currently no members.
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
    /// Members today: NONE — <c>origin.aggregate.via</c> flipped at the FR-024
    /// atomic all-ports manifest flip (optional everywhere, ADR-0029 decision 5).
    /// The mechanism stays for the next reference-first rollout.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, bool> Fr024PendingRequiredOverrides =
        new Dictionary<string, bool>(StringComparer.Ordinal);

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

    /// <summary>
    /// One attribute in the manifest — the logical, cross-port-identical facet.
    /// FR-033 — carries the documentation surface: <c>Description</c> (required +
    /// non-empty in the canonical) followed by the optional <c>Rules</c>/
    /// <c>Example</c>/<c>WhenToUse</c> (emitted only when present).
    /// </summary>
    private sealed record ManifestAttr(
        string Name,
        string? ValueType,
        bool IsArray,
        bool Required,
        IReadOnlyList<string>? AllowedValues,
        string Description,
        string? Rules,
        string? Example,
        string? WhenToUse);

    /// <summary>
    /// One structural child rule of a type (FR-033 constraint graph). Cardinality
    /// (<c>Min</c>/<c>Max</c>/<c>Named</c>) is emitted only when defined on the
    /// rule; <c>MaxIsNull</c> emits an explicit JSON <c>null</c> for a
    /// declared-unbounded upper bound (an absent <c>Max</c> is omitted entirely).
    /// </summary>
    private sealed record ManifestChild(
        string ChildType,
        string ChildSubType,
        string ChildName,
        int? Min,
        int? Max,
        bool MaxIsNull,
        bool? Named);

    /// <summary>
    /// One registered (type, subType) with its docs surface + declared attrs +
    /// the structural constraint graph (FR-033). Key order is fixed by
    /// construction: <c>type</c>, <c>subType</c>, <c>description</c>, optional
    /// <c>rules</c>/<c>example</c>/<c>whenToUse</c>, <c>attrs</c>, <c>children</c>,
    /// optional <c>parents</c>.
    /// </summary>
    private sealed record ManifestType(
        string Type,
        string SubType,
        string Description,
        string? Rules,
        string? Example,
        string? WhenToUse,
        IReadOnlyList<ManifestAttr> Attrs,
        IReadOnlyList<ManifestChild> Children,
        IReadOnlyList<string> Parents);

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
            // The type IS registered (it came from AllTypes()), so Find is non-null.
            .Select(typeId => ToManifestType(registry.Find(typeId.Type, typeId.SubType)!))
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
        // ADR-0036 Wave 1 — the closed-value-set facet. Emitted (between `required`
        // and `description`) ONLY when the attr declares a closed set; open /
        // format-validated attrs carry NO allowedValues (the key is omitted, never
        // `null`). Values come straight from the port's registered constants, in
        // declaration order (NOT sorted — array order is part of the contract).
        IReadOnlyList<string>? allowedValues = a.AllowedValues is { Count: > 0 } av
            ? av.Select(v => v?.ToString() ?? string.Empty).ToList()
            : null;
        // FR-033 — the documentation surface follows the existing facets, in fixed
        // key order: name, valueType, isArray, required, allowedValues?, description,
        // then the optional rules/example/whenToUse (emitted only when present).
        return new ManifestAttr(a.Name, valueType, isArray, a.Required, allowedValues, a.Description, a.Rules, a.Example, a.WhenToUse);
    }

    // ------------------------------------------------------------------
    // FR-033 — the structural constraint graph (children) + per-type assembly
    // ------------------------------------------------------------------

    /// <summary>
    /// The canonical sort key for a child rule's subType: the string itself (the
    /// single-string / wildcard form). A list-of-admitted-subtypes form arrives in
    /// S-B2a; for now the comma-join is a no-op over the single string.
    /// </summary>
    private static string ChildSubTypeKey(string childSubType) => childSubType;

    /// <summary>
    /// Normalize one structural <see cref="ChildRule"/> to the manifest's child
    /// shape (FR-033). Cardinality (<c>Min</c>/<c>Max</c>/<c>Named</c>) is emitted
    /// ONLY when defined on the rule; <c>Max</c> may be the explicit JSON
    /// <c>null</c> literal when declared-unbounded (<c>MaxIsNull</c>); an absent
    /// <c>Max</c> is omitted entirely.
    /// </summary>
    private static ManifestChild ToManifestChild(ChildRule rule) =>
        new(rule.ChildType, rule.ChildSubType, rule.ChildName, rule.Min, rule.Max, rule.MaxIsNull, rule.Named);

    /// <summary>
    /// Build the FR-033 constraint graph for one (type, subType) from its
    /// STRUCTURAL child rules — every <see cref="ChildRule"/> whose
    /// <c>ChildType</c> is NOT the attr type (the strict model has no any-attr
    /// wildcard; an <c>attr</c> child rule is dropped — it is expressed by the
    /// attrs block). De-duped + sorted by (childType, childSubTypeKey, childName),
    /// matching the TS reference's <c>sortedChildren</c>.
    ///
    /// NOTE: C#'s current child rules are broad / carry no cardinality, so the
    /// emitted content is wrong until S-B2a sources the strict graph from
    /// spec/metamodel/*.json — that is the expected intermediate (VALUE-level) diff.
    /// </summary>
    private static List<ManifestChild> SortedChildren(IReadOnlyList<ChildRule> rules)
    {
        Dictionary<string, ManifestChild> byKey = new(StringComparer.Ordinal);
        foreach (ChildRule rule in rules)
        {
            if (rule.ChildType == BaseTypes.TYPE_ATTR)
            {
                continue; // attr requirement is the attrs block; strict model has no attr wildcard
            }
            string key = $"{rule.ChildType} {ChildSubTypeKey(rule.ChildSubType)} {rule.ChildName}";
            if (!byKey.ContainsKey(key))
            {
                byKey[key] = ToManifestChild(rule);
            }
        }
        return byKey.Values
            .OrderBy(c => c.ChildType, StringComparer.Ordinal)
            .ThenBy(c => ChildSubTypeKey(c.ChildSubType), StringComparer.Ordinal)
            .ThenBy(c => c.ChildName, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Build one manifest type entry from its full <see cref="TypeDefinition"/>
    /// (FR-033). Key order is fixed: <c>type</c>, <c>subType</c>,
    /// <c>description</c>, optional <c>rules</c>/<c>example</c>/<c>whenToUse</c>,
    /// <c>attrs</c>, <c>children</c>, optional <c>parents</c> (sorted ASCII when
    /// present + non-empty).
    /// </summary>
    private static ManifestType ToManifestType(TypeDefinition def) =>
        new(
            def.TypeId.Type,
            def.TypeId.SubType,
            def.Description,
            def.Rules,
            def.Example,
            def.WhenToUse,
            SortedPerTypeAttrs(def.Attributes, def.TypeId.Type, def.TypeId.SubType),
            SortedChildren(def.ChildRules),
            def.Parents);

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
    ///    each attr as <c>name</c>, <c>valueType</c>, <c>isArray</c>, <c>required</c>,
    ///    optional <c>allowedValues</c> (ADR-0036 Wave 1; only-when-closed), <c>description</c>.
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
                // FR-033 — description (required) then the optional docs facets,
                // each emitted ONLY when present so absent keys stay absent.
                writer.WriteString("description", t.Description);
                if (t.Rules is not null) writer.WriteString("rules", t.Rules);
                if (t.Example is not null) writer.WriteString("example", t.Example);
                if (t.WhenToUse is not null) writer.WriteString("whenToUse", t.WhenToUse);
                writer.WriteStartArray("attrs");
                foreach (ManifestAttr a in t.Attrs)
                {
                    WriteAttr(writer, a);
                }
                writer.WriteEndArray();
                // FR-033 — the structural constraint graph.
                writer.WriteStartArray("children");
                foreach (ManifestChild c in t.Children)
                {
                    WriteChild(writer, c);
                }
                writer.WriteEndArray();
                // FR-033 — the child-side placement claim, emitted only when
                // present + non-empty (sorted ASCII).
                if (t.Parents.Count > 0)
                {
                    writer.WriteStartArray("parents");
                    foreach (string parent in t.Parents.OrderBy(p => p, StringComparer.Ordinal))
                    {
                        writer.WriteStringValue(parent);
                    }
                    writer.WriteEndArray();
                }
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
        // ADR-0036 Wave 1 — allowedValues (the closed-value-set facet) between
        // `required` and `description`, ONLY when the attr declares a closed set
        // (only-when-closed: the key is OMITTED, never emitted as `null`). Array
        // order is the registered declaration order, NOT sorted.
        if (a.AllowedValues is { Count: > 0 } allowed)
        {
            writer.WriteStartArray("allowedValues");
            foreach (string value in allowed)
            {
                writer.WriteStringValue(value);
            }
            writer.WriteEndArray();
        }
        // FR-033 — description (required) then the optional docs facets, each
        // emitted ONLY when present.
        writer.WriteString("description", a.Description);
        if (a.Rules is not null) writer.WriteString("rules", a.Rules);
        if (a.Example is not null) writer.WriteString("example", a.Example);
        if (a.WhenToUse is not null) writer.WriteString("whenToUse", a.WhenToUse);
        writer.WriteEndObject();
    }

    /// <summary>
    /// Write one structural child rule (FR-033 constraint graph). Key order:
    /// <c>childType</c>, <c>childSubType</c>, <c>childName</c>, then optional
    /// <c>min</c>/<c>max</c>/<c>named</c> (each emitted ONLY when defined on the
    /// rule). <c>max: null</c> is written when <c>MaxIsNull</c>; an absent
    /// <c>Max</c> is omitted entirely.
    /// </summary>
    private static void WriteChild(Utf8JsonWriter writer, ManifestChild c)
    {
        writer.WriteStartObject();
        writer.WriteString("childType", c.ChildType);
        writer.WriteString("childSubType", c.ChildSubType);
        writer.WriteString("childName", c.ChildName);
        if (c.Min is not null) writer.WriteNumber("min", c.Min.Value);
        if (c.Max is not null)
        {
            writer.WriteNumber("max", c.Max.Value);
        }
        else if (c.MaxIsNull)
        {
            writer.WriteNull("max"); // declared-unbounded upper bound
        }
        if (c.Named is not null) writer.WriteBoolean("named", c.Named.Value);
        writer.WriteEndObject();
    }
}
