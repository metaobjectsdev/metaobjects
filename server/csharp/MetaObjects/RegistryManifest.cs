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

    /// <summary>`isAbstract` as the per-type attr name (the contract's bare `abstract` structural keyword).</summary>
    private const string AttrNameIsAbstract = "isAbstract";

    /// <summary>The Java-OO structural-shape keyword names (`implements`/`isInterface`) as per-type attr names — bare OO-shape keywords (the OO modeling spine), not cross-port per-type attrs. No-op for C# (never registers them); the filter drops Java's per-type registrations. See SP-G C-2/C-3 (Unit 6b).</summary>
    private const string AttrNameImplements = "implements";
    private const string AttrNameIsInterface = "isInterface";

    /// <summary>Per-type attr names filtered from a type's <c>attrs</c> list (structural / OO-shape keywords + the description commonAttr).</summary>
    private static readonly HashSet<string> ExcludedPerTypeAttrNames = new(StringComparer.Ordinal)
    {
        Structural.RESERVED_KEY_IS_ARRAY,
        AttrNameIsAbstract,
        Structural.RESERVED_KEY_EXTENDS,
        AttrNameImplements,
        AttrNameIsInterface,
        DocumentationConstants.DOC_ATTR_DESCRIPTION,
    };

    /// <summary>True if a <c>(type, subType)</c> row is excluded: the metadata.base anchor + the generic view.* controls.</summary>
    private static bool IsExcludedTypeSubType(string type, string subType)
    {
        if (type == BaseTypes.TYPE_METADATA && subType == BaseTypes.SUBTYPE_BASE)
        {
            return true; // C-5 — Java's internal inheritance anchor
        }
        if (type == BaseTypes.TYPE_VIEW
            && subType != BaseTypes.SUBTYPE_BASE
            && subType != ViewConstants.VIEW_SUBTYPE_CURRENCY)
        {
            return true; // B-2 — TS-web-presentation-only generic view controls
        }
        return false;
    }

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
                SortedPerTypeAttrs(registry.AttrsOf(typeId.Type, typeId.SubType))))
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
    /// As <see cref="SortedAttrs"/>, but filtering the excluded per-type attr
    /// names (structural keywords + the <c>description</c> commonAttr). Applied
    /// ONLY to per-type attrs — <c>description</c> stays in the commonAttrs block.
    /// </summary>
    private static List<ManifestAttr> SortedPerTypeAttrs(IReadOnlyList<AttrSchema> attrs) =>
        SortedAttrs(attrs.Where(a => !ExcludedPerTypeAttrNames.Contains(a.Name)).ToList());

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
